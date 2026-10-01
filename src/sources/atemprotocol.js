/**
 * The switcher protocol: a UDP socket with sequence numbers, acknowledgements
 * and retransmission on top of it, and nothing about meters above that.
 *
 * It hands the adapter whole commands, each a four letter name and a body.
 */

const { createSocket } = require('node:dgram')

// The port the switcher listens on. It is not a setting.
const DEVICE_PORT = 9910

// The header is twelve bytes, big endian throughout. The first two carry the
// flags in the top five bits and the whole packet's length in the low eleven.
const HEADER_LENGTH = 12
const LENGTH_MASK = 0x07ff
const FLAG_SHIFT = 11

// Header field offsets.
const AT_SESSION = 2
const AT_ACK = 4
const AT_RESEND_FROM = 6
const AT_SPARE = 8
const AT_PACKET_ID = 10

// Packet flags.
const FLAG_ACK_WANTED = 0x01
const FLAG_NEW_SESSION = 0x02
const FLAG_IS_RESEND = 0x04
const FLAG_RESEND_WANTED = 0x08
const FLAG_ACK = 0x10

// Packet ids run to fifteen bits and then wrap.
const PACKET_ID_LIMIT = 1 << 15

// A command block: two bytes of length covering the whole block, two of padding,
// four of name, then the body.
const BLOCK_HEADER_LENGTH = 8
const AT_BLOCK_NAME = 4

// The payload of the opening packet.
const OPENING_PAYLOAD = Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0])

// The value the opening packet carries in the one header field the protocol
// leaves unnamed. The switcher refuses an opening packet that does not match
// what its own control application sends.
const OPENING_SPARE = 0x003a

// The command that closes the state dump. Until it arrives the session is open
// but what the switcher holds is only half known.
const COMMAND_READY = 'InCm'

// The two commands carrying levels: one per source, one for the master out.
const COMMAND_SOURCE_LEVELS = 'FMLv'
const COMMAND_MASTER_LEVELS = 'FDLv'

// The command that switches the level feed on and off.
const COMMAND_SEND_LEVELS = 'SFLN'

const RECONNECT_DELAY_MS = 3000

// How long a connection is given to get from the opening packet to the end of
// the state dump.
const HANDSHAKE_TIMEOUT_MS = 10000

// How long the far end may go quiet before the connection is given up on. The
// switcher sends packets of its own to be acknowledged, so silence is a fault
// rather than an idle line.
const SILENCE_TIMEOUT_MS = 5000

// How often the watchdog looks at the clock.
const WATCHDOG_MS = 1000

// How long a sent packet waits for its acknowledgement before it is sent again,
// and how many times it may be.
const RESEND_AFTER_MS = 60
const RESEND_LIMIT = 10

// How often the level subscription is sent again while the levels are wanted.
// Wide enough to cost nothing and short enough that a feed which has to be
// renewed never stops for long.
const RENEW_LEVELS_MS = 10000

// How far ahead of the next expected packet a packet may be and still be held
// while the gap fills. The switcher keeps resending, so this only has to cover
// how deep it lets the gap get.
const REORDER_LIMIT = 256

// How many packets may arrive before an acknowledgement is due, and how long one
// may wait so that a run of packets is covered by a single acknowledgement.
const ACK_AFTER_PACKETS = 16
const ACK_DELAY_MS = 5

/**
 * One connection to a switcher, with reconnection.
 *
 *   onStatus(state, message)  'connecting' | 'connected' | 'failed'
 *   onLevels(name, body)      a level command, while they are subscribed to
 *   onEvent(name, body)       any other command that arrived
 */
class AtemConnection {
	constructor(handlers) {
		this.handlers = handlers
		this.socket = null
		this.config = {}

		this.wanted = false
		this.ready = false

		// The session the switcher assigned. Every packet carries it, and the opening
		// packet carries a made up one until the switcher answers with its own.
		this.sessionId = 0

		this.nextPacketId = 1
		this.lastReceivedId = 0

		// Packets sent and not yet acknowledged, oldest first.
		this.inFlight = []

		// Packets that arrived ahead of their turn, by packet id.
		this.held = new Map()

		this.sinceAck = 0
		this.lastHeardAt = 0

		// Whether the levels are wanted, and whether this session has been told so.
		// The answer can change while there is no session to tell, and a reconnection
		// starts a session that knows nothing.
		this.wantLevels = false
		this.toldLevels = null

		// The last failure reported, so one reason is not logged once per attempt.
		this.lastFailure = null

		// How often the subscription is sent again. Zero sends it once and leaves it,
		// which is what measuring whether it expires needs.
		this.renewEvery = RENEW_LEVELS_MS

		this.reconnectTimer = null
		this.handshakeTimer = null
		this.watchdogTimer = null
		this.resendTimer = null
		this.ackTimer = null
		this.renewTimer = null
	}

	get isReady() {
		return this.ready
	}

	/**
	 * Ask for the level feed, or stop asking. Sends nothing unless the answer has
	 * changed, so this can be called as often as the caller likes.
	 */
	watchLevels(wanted) {
		this.wantLevels = !!wanted
		this.syncSubscription()
	}

	syncSubscription() {
		if (this.wantLevels && !this.renewTimer && this.renewEvery > 0) {
			this.renewTimer = setInterval(() => this.sendSubscription(), this.renewEvery)
		}
		if (!this.wantLevels && this.renewTimer) {
			clearInterval(this.renewTimer)
			this.renewTimer = null
		}
		if (!this.ready || this.toldLevels === this.wantLevels) return
		this.sendSubscription()
	}

	sendSubscription() {
		if (!this.ready) return
		const body = Buffer.alloc(4)
		body.writeUInt8(this.wantLevels ? 1 : 0, 0)
		if (this.sendCommand(COMMAND_SEND_LEVELS, body)) {
			// Recorded as told at the moment it is sent. Anything that ends the session
			// clears it again.
			this.toldLevels = this.wantLevels
		}
	}

	connect(config) {
		this.wanted = true
		this.config = config
		this.open()
	}

	close() {
		this.wanted = false
		this.clearReconnect()
		this.clearHandshake()
		this.clearWatchdog()
		this.clearResend()
		this.clearAck()
		if (this.renewTimer) {
			clearInterval(this.renewTimer)
			this.renewTimer = null
		}
		this.dropSocket()
	}

	open() {
		const host = this.config.atemHost || '127.0.0.1'
		this.handlers.onStatus('connecting', `connecting to ${host}`)

		let socket
		try {
			socket = createSocket('udp4')
		} catch (error) {
			this.fail(`cannot open a socket: ${error.message}`)
			return
		}
		this.socket = socket
		this.ready = false
		this.toldLevels = null
		this.sinceAck = 0
		this.nextPacketId = 1
		this.lastReceivedId = 0
		this.inFlight = []
		this.held.clear()
		this.lastHeardAt = Date.now()

		socket.on('message', (packet) => {
			if (socket !== this.socket) return
			this.receive(packet)
		})
		socket.on('error', (error) => {
			if (socket !== this.socket) return
			this.dropSocket()
			this.fail(`the socket failed: ${error.message}`)
		})

		// A made up session id for the opening packet alone. The switcher answers with
		// the one to use from then on.
		this.sessionId = 1 + Math.floor(Math.random() * 0xfffe)
		this.sendOpening()

		// Give the handshake a deadline, or a switcher that answers once and then says
		// nothing holds the connection in "connecting" for ever.
		this.clearHandshake()
		this.handshakeTimer = setTimeout(() => {
			this.handshakeTimer = null
			if (socket !== this.socket || this.ready) return
			this.dropSocket()
			this.fail(`no switcher answered at ${host}.`)
		}, HANDSHAKE_TIMEOUT_MS)

		this.clearWatchdog()
		this.watchdogTimer = setInterval(() => this.checkSilence(), WATCHDOG_MS)
	}

	/** Let go of the current socket without giving up on reconnecting. */
	dropSocket() {
		const socket = this.socket
		this.socket = null
		this.ready = false
		this.toldLevels = null
		this.inFlight = []
		this.held.clear()
		this.clearAck()
		this.clearResend()
		if (socket) {
			try {
				socket.close()
			} catch {
				// Already gone. Nothing to do.
			}
		}
	}

	fail(message) {
		// One reason is reported once. A UDP connection retries every few seconds and
		// the same sentence every time tells a reader nothing new.
		if (this.lastFailure === message) {
			this.scheduleReconnect()
			return
		}
		this.lastFailure = message
		this.handlers.onStatus('failed', message)
		this.scheduleReconnect()
	}

	scheduleReconnect() {
		if (!this.wanted || this.reconnectTimer) return
		this.clearHandshake()
		this.clearWatchdog()
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			if (this.wanted) this.open()
		}, RECONNECT_DELAY_MS)
	}

	clearReconnect() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
	}

	clearHandshake() {
		if (this.handshakeTimer) {
			clearTimeout(this.handshakeTimer)
			this.handshakeTimer = null
		}
	}

	clearWatchdog() {
		if (this.watchdogTimer) {
			clearInterval(this.watchdogTimer)
			this.watchdogTimer = null
		}
	}

	clearResend() {
		if (this.resendTimer) {
			clearTimeout(this.resendTimer)
			this.resendTimer = null
		}
	}

	clearAck() {
		if (this.ackTimer) {
			clearTimeout(this.ackTimer)
			this.ackTimer = null
		}
	}

	checkSilence() {
		// Before the session is open the handshake deadline owns the reporting, and it
		// is the longer of the two, so a far end that never answers is named as such
		// rather than as one that stopped.
		if (!this.socket || !this.ready) return
		if (Date.now() - this.lastHeardAt <= SILENCE_TIMEOUT_MS) return
		const host = this.config.atemHost || '127.0.0.1'
		this.dropSocket()
		this.fail(`the switcher at ${host} stopped answering.`)
	}

	/** The opening packet: the one that carries a made up session id. */
	sendOpening() {
		const length = HEADER_LENGTH + OPENING_PAYLOAD.length
		const packet = Buffer.alloc(length)
		packet.writeUInt16BE((FLAG_NEW_SESSION << FLAG_SHIFT) | length, 0)
		packet.writeUInt16BE(this.sessionId, AT_SESSION)
		packet.writeUInt16BE(OPENING_SPARE, AT_SPARE)
		OPENING_PAYLOAD.copy(packet, HEADER_LENGTH)
		this.transmit(packet)
	}

	/**
	 * Send one command and expect it to be acknowledged. Answers whether it went
	 * out at all.
	 */
	sendCommand(name, body) {
		if (!this.socket) return false

		const blockLength = BLOCK_HEADER_LENGTH + body.length
		const length = HEADER_LENGTH + blockLength
		const packetId = this.nextPacketId
		this.nextPacketId = (this.nextPacketId + 1) % PACKET_ID_LIMIT

		const packet = Buffer.alloc(length)
		packet.writeUInt16BE((FLAG_ACK_WANTED << FLAG_SHIFT) | length, 0)
		packet.writeUInt16BE(this.sessionId, AT_SESSION)
		packet.writeUInt16BE(packetId, AT_PACKET_ID)
		packet.writeUInt16BE(blockLength, HEADER_LENGTH)
		packet.write(name, HEADER_LENGTH + AT_BLOCK_NAME, 4, 'latin1')
		body.copy(packet, HEADER_LENGTH + BLOCK_HEADER_LENGTH)

		this.transmit(packet)
		this.inFlight.push({ packetId, packet, sentAt: Date.now(), tries: 0 })
		this.startResendTimer()
		return true
	}

	transmit(packet) {
		if (!this.socket) return
		const host = this.config.atemHost || '127.0.0.1'
		try {
			this.socket.send(packet, 0, packet.length, DEVICE_PORT, host)
		} catch {
			// The error event carries the reporting.
		}
	}

	receive(packet) {
		if (packet.length < HEADER_LENGTH) return
		const length = packet.readUInt16BE(0) & LENGTH_MASK
		if (length !== packet.length) return

		this.lastHeardAt = Date.now()
		const flags = packet.readUInt16BE(0) >> FLAG_SHIFT
		// The switcher assigns the session, so whatever it last used is the right one.
		this.sessionId = packet.readUInt16BE(AT_SESSION)
		const packetId = packet.readUInt16BE(AT_PACKET_ID)

		if (flags & FLAG_NEW_SESSION) {
			// The session is open. The state dump follows and nothing is usable until
			// it closes.
			this.lastReceivedId = packetId
			this.held.clear()
			this.sendAck()
			return
		}

		if (flags & FLAG_RESEND_WANTED) {
			this.resendFrom(packet.readUInt16BE(AT_RESEND_FROM) % PACKET_ID_LIMIT)
		}

		if (flags & FLAG_ACK) {
			this.settle(packet.readUInt16BE(AT_ACK))
		}

		if (!(flags & FLAG_ACK_WANTED) || packetId >= PACKET_ID_LIMIT) return
		this.take(packetId, packet.subarray(HEADER_LENGTH))
	}

	/**
	 * Accept one packet that wants acknowledging, in order. A packet ahead of its
	 * turn is held rather than delivered, and is not acknowledged, so the switcher
	 * fills the gap.
	 */
	take(packetId, payload) {
		const ahead = (packetId - this.lastReceivedId + PACKET_ID_LIMIT) % PACKET_ID_LIMIT

		if (ahead > 1) {
			if (ahead <= REORDER_LIMIT && !this.held.has(packetId)) this.held.set(packetId, payload)
			else if (ahead > REORDER_LIMIT) this.sendAckSoon()
			return
		}

		if (ahead === 0) {
			// Already had it. Acknowledge again so the switcher stops sending it.
			this.sendAckSoon()
			return
		}

		this.lastReceivedId = packetId
		this.deliver(payload)

		let drained = 0
		for (;;) {
			const next = (this.lastReceivedId + 1) % PACKET_ID_LIMIT
			const waiting = this.held.get(next)
			if (!waiting) break
			this.held.delete(next)
			this.lastReceivedId = next
			this.deliver(waiting)
			drained++
		}

		if (drained > 0) this.sendAck()
		else this.sendAckSoon()
	}

	/** Split one payload into the commands it carries. */
	deliver(payload) {
		let at = 0
		while (at + BLOCK_HEADER_LENGTH <= payload.length) {
			const blockLength = payload.readUInt16BE(at)
			if (blockLength < BLOCK_HEADER_LENGTH || at + blockLength > payload.length) return
			const name = payload.toString('latin1', at + AT_BLOCK_NAME, at + AT_BLOCK_NAME + 4)
			const body = payload.subarray(at + BLOCK_HEADER_LENGTH, at + blockLength)
			this.dispatch(name, body)
			at += blockLength
		}
	}

	dispatch(name, body) {
		if (name === COMMAND_READY) {
			// The switcher sends this at the end of every full dump, so only the first
			// one opens the connection and none of them may forget what the session has
			// been told it is subscribed to.
			const opened = !this.ready
			this.ready = true
			this.clearHandshake()
			this.lastFailure = null
			// A new session arrives with the levels switched off, so saying so costs a
			// packet and nothing else. Null means there is no session to have told.
			if (opened) this.toldLevels = false
			// In case the wish changed while the dump was in flight.
			this.syncSubscription()
			if (opened) this.handlers.onStatus('connected', '')
			return
		}

		if (name === COMMAND_SOURCE_LEVELS || name === COMMAND_MASTER_LEVELS) {
			this.handlers.onLevels(name, body)
			return
		}

		this.handlers.onEvent(name, body)
	}

	sendAck() {
		this.sinceAck = 0
		this.clearAck()
		const packet = Buffer.alloc(HEADER_LENGTH)
		packet.writeUInt16BE((FLAG_ACK << FLAG_SHIFT) | HEADER_LENGTH, 0)
		packet.writeUInt16BE(this.sessionId, AT_SESSION)
		packet.writeUInt16BE(this.lastReceivedId, AT_ACK)
		this.transmit(packet)
	}

	/** Acknowledge shortly, so a run of packets costs one acknowledgement. */
	sendAckSoon() {
		this.sinceAck++
		if (this.sinceAck >= ACK_AFTER_PACKETS) {
			this.sendAck()
			return
		}
		if (this.ackTimer) return
		this.ackTimer = setTimeout(() => {
			this.ackTimer = null
			this.sendAck()
		}, ACK_DELAY_MS)
	}

	/**
	 * Whether a packet id falls at or before an acknowledgement, counting the wrap.
	 * Half the range is taken as the furthest apart two live ids can be.
	 */
	coveredBy(ackId, packetId) {
		if (packetId === ackId) return true
		return (ackId - packetId + PACKET_ID_LIMIT) % PACKET_ID_LIMIT < PACKET_ID_LIMIT / 2
	}

	settle(ackId) {
		this.inFlight = this.inFlight.filter((entry) => !this.coveredBy(ackId, entry.packetId))
		if (this.inFlight.length === 0) this.clearResend()
	}

	/** Send again everything from one packet id onward, in the order it first went. */
	resendFrom(packetId) {
		const from = this.inFlight.findIndex((entry) => entry.packetId === packetId)
		if (from === -1) return
		const now = Date.now()
		for (let at = from; at < this.inFlight.length; at++) {
			const entry = this.inFlight[at]
			entry.sentAt = now
			entry.tries++
			// The flag says this is not the first time, which is what lets the switcher
			// tell a resend from a new packet carrying a reused id.
			entry.packet.writeUInt16BE(((FLAG_ACK_WANTED | FLAG_IS_RESEND) << FLAG_SHIFT) | entry.packet.length, 0)
			this.transmit(entry.packet)
		}
		this.startResendTimer()
	}

	startResendTimer() {
		if (this.resendTimer || this.inFlight.length === 0) return
		this.resendTimer = setTimeout(() => {
			this.resendTimer = null
			this.checkResends()
		}, RESEND_AFTER_MS)
	}

	checkResends() {
		if (this.inFlight.length === 0) return
		const now = Date.now()
		for (const entry of this.inFlight) {
			if (entry.sentAt + RESEND_AFTER_MS > now) continue
			if (entry.tries >= RESEND_LIMIT) {
				const host = this.config.atemHost || '127.0.0.1'
				this.dropSocket()
				this.fail(`the switcher at ${host} is not acknowledging what is sent to it.`)
				return
			}
			this.resendFrom(entry.packetId)
			return
		}
		this.startResendTimer()
	}
}

module.exports = { AtemConnection }
