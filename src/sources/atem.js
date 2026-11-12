/**
 * The switcher adapter: the connection, the catalog of Fairlight sources, the
 * mix option, the fader, the processing stages and the tally, handed on as the
 * plain record src/source.js describes. The protocol itself is in
 * atemprotocol.js.
 */

const { AtemConnection } = require('./atemprotocol.js')
const { Loudness, Peak } = require('../ballistics.js')
const { Answers, MIX_ID, MIX_NAME } = require('../source.js')

/*
 * WHICH METERING POINT IS WHICH, AND WHAT A LEVEL FIELD MEANS.
 *
 * UNVERIFIED. Nothing below has been read off a desk. The level command carries
 * three pairs of readings per source and the contract takes two, so this table
 * is the whole of that choice and correcting it is an edit here and nowhere
 * else. The machine's own documentation names one metering point for a source,
 * its output, and gives levels as decibels with a level and a peak together.
 *
 * A level command carries three pairs, and the machine's own documentation
 * splits them across two callbacks: the first two belong to the dynamics
 * processor, its input and its output, and the third belongs to the source
 * itself. The gain reduction of the expander, the compressor and the limiter
 * sits between the first two in the packet, which is the same statement made in
 * the layout.
 *
 *   pre   the dynamics input, which stands before the fader
 *   post  the source output, which stands after it
 *
 * The dynamics output is read and not used: it is still before the fader, so
 * drawing it as the outgoing bar would make a fader move nothing.
 *
 * The packet's peak fields are the highest reading since the operator last
 * reset them rather than the peak of the moment, so they are not what a falling
 * bar is drawn from: the bar and the line both come from the level, and the
 * module's own curves separate them.
 */
const PRE_POINT = 'input'
const POST_POINT = 'third'

// What one unit of a level field is worth. The fader and gain fields are
// documented over ranges that fit only this scale.
const LEVEL_PER_DB = 100

// At or below this many decibels a reading counts as nothing at all.
const SILENT_DB = -120

// Where the audio has to arrive for a source to count as on air. The machine's
// own documentation defines its mixed-in flag against the program bus. A desk
// whose outputs are routed separately would need this to become a setting.
const DESTINATION = 'program'

// The three states a source's mix option takes.
const MIX_OFF = 1
const MIX_ON = 2
const MIX_FOLLOWS_VIDEO = 4

// Commands carrying what the adapter needs.
const SOURCE_LEVELS = 'FMLv'
const MASTER_LEVELS = 'FDLv'
const SOURCE_PROPERTIES = 'FASP'
const SOURCE_GONE = 'FASD'
const MASTER_PROPERTIES = 'FAMP'
const EXPANDER = 'AIXP'
const COMPRESSOR = 'AICP'
const LIMITER = 'AILP'
const MASTER_COMPRESSOR = 'MOCP'
const MASTER_LIMITER = 'AMLP'
const INPUT_PROPERTIES = 'InPr'
const TALLY = 'TlSr'

// Where each reading sits in a source's level command: the pair of channels at
// the level offset, and the pair at the peak offset.
const SOURCE_POINTS = {
	input: { level: 10, peak: 14 },
	output: { level: 24, peak: 28 },
	third: { level: 32, peak: 36 },
}
const SOURCE_LEVELS_LENGTH = 40
const AT_LEVELS_SOURCE = 0
const AT_LEVELS_INDEX = 8

// The same for the master out, which carries no expander and so sits four bytes
// earlier from the dynamics onward.
const MASTER_POINTS = {
	input: { level: 0, peak: 4 },
	output: { level: 12, peak: 16 },
	third: { level: 20, peak: 24 },
}
const MASTER_LEVELS_LENGTH = 28

// A level command carries two channels at each metering point.
const CHANNELS_PER_POINT = 2

// Where each fact sits in a source's properties command.
const AT_PROPERTIES_INDEX = 0
const AT_PROPERTIES_SOURCE = 8
const AT_EQUALIZER_ENABLED = 29
const AT_FADER_GAIN = 44
const AT_MIX_OPTION = 49
const SOURCE_PROPERTIES_LENGTH = 50

// Where each fact sits in a dynamics stage's command, which is the same for the
// expander, the compressor and the limiter.
const AT_STAGE_INDEX = 0
const AT_STAGE_SOURCE = 8
const AT_STAGE_ENABLED = 16
const STAGE_LENGTH = 17

// Where each fact sits in the master's properties command.
const AT_MASTER_EQUALIZER_ENABLED = 1
const AT_MASTER_FADER_GAIN = 12
const MASTER_PROPERTIES_LENGTH = 20

// Where the enabled flag sits in the master's compressor and limiter commands,
// which carry no index and no source id because there is one master.
const AT_MASTER_STAGE_ENABLED = 0
const MASTER_COMPRESSOR_LENGTH = 24
const MASTER_LIMITER_LENGTH = 20

// An input's name, and how much room it is given.
const AT_INPUT_ID = 0
const AT_INPUT_NAME = 2
const INPUT_NAME_LENGTH = 20

// The external audio inputs, which the switcher lists without ever naming. The
// names are the ones on the hardware.
const EXTERNAL_NAMES = new Map([
	[1301, 'MIC 1'],
	[1302, 'MIC 2'],
])

// The tally command: a count, then three bytes per source.
const TALLY_ENTRY_LENGTH = 3
const TALLY_PROGRAM = 0x01

// How long the whole feed may go silent before the meters give up on it. Wide
// enough for network latency and a slow answer.
const FEED_SILENCE_MS = 5000

// How long one source may go without a level before it counts as not being
// mixed. Several times the gap between frames, so a late frame is not read as a
// source leaving.
const SOURCE_SILENCE_MS = 1000

// How long a change to the catalog waits before it is announced, so a burst of
// them folds into one.
const CATALOG_SWEEP_MS = 200

/** A level field as the multiplier the contract is written in, full scale being 1.0. */
function fromLevelField(value) {
	const db = value / LEVEL_PER_DB
	if (db <= SILENT_DB) return 0
	return Math.min(1, Math.pow(10, db / 20))
}

/** Read one metering point's pair of channels out of a level command's body. */
function readPoint(body, point) {
	const channels = []
	for (let index = 0; index < CHANNELS_PER_POINT; index++) {
		const step = index * 2
		channels.push({
			level: body.readInt16BE(point.level + step),
			peak: body.readInt16BE(point.peak + step),
		})
	}
	return channels
}

/** A name laid out as a fixed field, which the far end pads with zeroes. */
function readName(body, at, length) {
	const end = Math.min(at + length, body.length)
	const text = body.toString('utf8', at, end)
	const stop = text.indexOf('\u0000')
	return stop === -1 ? text : text.slice(0, stop)
}

/**
 * One switcher, as a source of levels. The surface it answers is defined in
 * src/source.js; `options` is the connection form, read for the switcher's
 * address. The port is fixed by the protocol and is not a setting.
 */
class Source {
	constructor(options, handlers) {
		this.options = options
		this.handlers = handlers

		// Every Fairlight source, keyed by its input and its own id together, since one
		// input can be split into two sources.
		this.sources = new Map()

		// The master out, which the switcher meters itself and which carries processing
		// and a fader of its own.
		this.master = { channels: [], volume: 1, stages: {}, lastLevelAt: undefined }

		// Each input's name, by input id.
		this.names = new Map()

		// Which video sources are on air, by source id.
		this.tally = new Map()

		this.connection = new AtemConnection({
			onStatus: (state, message) => this.handleStatus(state, message),
			onLevels: (name, body) => this.handleLevels(name, body),
			onEvent: (name, body) => this.handleEvent(name, body),
		})

		// Where the drawn loudness and the drawn peak of each channel stand. They live
		// with the frames because both move by elapsed time and are advanced by a frame
		// arriving.
		this.loudness = new Loudness()
		this.peakFall = new Peak()

		this.lastFrameAt = undefined
		this.catalogTimer = null
	}

	/**
	 * What this adapter answers, and how well; the vocabulary is in src/source.js.
	 * One of them is ASSUMED: a source whose audio follows its video needs the tally
	 * of that video, and where the tally says nothing about the input the source is
	 * taken to be reaching the destination.
	 */
	get capabilities() {
		return {
			pre: Answers.MEASURED,
			muted: Answers.MEASURED,
			fader: Answers.MEASURED,
			routing: Answers.ASSUMED,
			live: Answers.MEASURED,
			mix: Answers.MEASURED,
			filters: Answers.MEASURED,
			mixFader: Answers.MEASURED,
			mixFilters: Answers.MEASURED,
		}
	}

	start() {
		this.connection.connect(this.options)
	}

	stop() {
		if (this.catalogTimer) {
			clearTimeout(this.catalogTimer)
			this.catalogTimer = null
		}
		this.connection.close()
	}

	watchLevels(wanted) {
		this.connection.watchLevels(wanted)
	}

	/** The sources to offer, the mix first, then the sources by name. */
	list() {
		const sources = [...this.sources.keys()]
			.map((id) => ({ id, name: this.nameOf(id) }))
			.sort((a, b) => a.name.localeCompare(b.name))
		if (sources.length === 0) return []
		return [{ id: MIX_ID, name: MIX_NAME }, ...sources]
	}

	/**
	 * What one source is called. An input split into two sources carries its own id
	 * as well, since the input's name alone would name both.
	 */
	nameOf(id) {
		const entry = this.sources.get(id)
		if (!entry) return id
		const name = this.names.get(entry.index) || EXTERNAL_NAMES.get(entry.index) || `Input ${entry.index}`
		return this.splitInputs().has(entry.index) ? `${name} ${entry.source}` : name
	}

	/** The inputs carrying more than one source. */
	splitInputs() {
		const seen = new Set()
		const split = new Set()
		for (const entry of this.sources.values()) {
			if (seen.has(entry.index)) split.add(entry.index)
			seen.add(entry.index)
		}
		return split
	}

	/** Everything known about one source, or undefined if it is not one of ours. */
	get(id) {
		const entry = this.sources.get(id)
		if (!entry) return undefined
		return {
			name: this.nameOf(id),
			channels: entry.channels,
			muted: entry.mixOption === MIX_OFF,
			volume: entry.volume,
			reaches: this.reaches(entry),
			filters: this.stagesOf(entry),
			reporting: this.isReporting(entry),
		}
	}

	/**
	 * Whether a source reaches the destination.
	 *
	 * The mix option has three states. Off is a real mute and reaches nothing. On
	 * always reaches. The third makes the audio follow its video, so it reaches only
	 * while that video is on air, which takes the tally as well as the audio state.
	 * Where the tally says nothing about the input the answer is not known, and the
	 * contract calls a source off air only where it is known to be.
	 */
	reaches(entry) {
		if (entry.mixOption === MIX_OFF) return false
		if (entry.mixOption !== MIX_FOLLOWS_VIDEO) return true
		const tally = this.tally.get(entry.index)
		if (!tally) return true
		return !!tally[DESTINATION]
	}

	/**
	 * The processing stages a source or the master carries and which of them are
	 * switched on. A stage the switcher has not reported is left out rather than
	 * reported off, which is how the master comes to have no expander.
	 */
	stagesOf(entry) {
		const stages = []
		for (const stage of ['equalizer', 'expander', 'compressor', 'limiter']) {
			if (entry.stages[stage] !== undefined) stages.push(entry.stages[stage])
		}
		return stages
	}

	/**
	 * The current levels of a source, or null when it is not reporting. Null is a
	 * state of its own: the source is not being mixed, which is not being quiet.
	 */
	readings(id) {
		if (!this.feedIsAlive()) return null
		const entry = this.sources.get(id)
		if (!entry || !this.isReporting(entry)) return null
		return entry.channels
	}

	/**
	 * The mix, as one member carrying the switcher's own reading of its master out.
	 * The drawing adds the members it is given as a root of squares, and one member
	 * adds up to itself, so what is drawn is what was measured.
	 */
	mixMembers() {
		if (!this.feedIsAlive()) return null
		if (this.master.lastLevelAt === undefined) return null
		if (Date.now() - this.master.lastLevelAt > SOURCE_SILENCE_MS) return null
		return [{ id: MIX_ID, readings: this.master.channels }]
	}

	/**
	 * The mix's own fader and processing. The master out carries an equalizer, a
	 * compressor, a limiter and a fader of its own, and all four are read.
	 */
	getMix() {
		return { volume: this.master.volume, filters: this.stagesOf(this.master) }
	}

	/** Whether the level commands are arriving at all, asked of the feed rather than per source. */
	feedIsAlive() {
		return this.lastFrameAt !== undefined && Date.now() - this.lastFrameAt <= FEED_SILENCE_MS
	}

	isReporting(entry) {
		return entry.lastLevelAt !== undefined && Date.now() - entry.lastLevelAt <= SOURCE_SILENCE_MS
	}

	handleStatus(state, message) {
		this.handlers.onStatus(state, message)
		if (state === 'connected') this.handlers.onChanged()
	}

	/** Announce a change to the catalog shortly, so a burst of them costs one sweep. */
	scheduleChanged() {
		if (this.catalogTimer) return
		this.catalogTimer = setTimeout(() => {
			this.catalogTimer = null
			this.handlers.onChanged()
		}, CATALOG_SWEEP_MS)
	}

	handleLevels(name, body) {
		if (name === SOURCE_LEVELS) this.handleSourceLevels(body)
		else if (name === MASTER_LEVELS) this.handleMasterLevels(body)
	}

	/**
	 * Store one source's levels.
	 *
	 * A source the switcher has not described is ignored. Its properties arrive in
	 * the state dump, before the levels are ever asked for, so nothing here has to
	 * fill in a mute or a fader that was never read.
	 *
	 * The drawn curves are advanced here, because frames arrive more often than the
	 * buttons are repainted. The readings are kept beside them.
	 */
	handleSourceLevels(body) {
		if (body.length < SOURCE_LEVELS_LENGTH) return
		const id = `${body.readUInt16BE(AT_LEVELS_INDEX)}.${body.readBigInt64BE(AT_LEVELS_SOURCE)}`
		const entry = this.sources.get(id)
		if (!entry) return

		const now = Date.now()
		entry.channels = this.channelsFrom(id, body, SOURCE_POINTS, now)
		entry.lastLevelAt = now
		this.lastFrameAt = now
	}

	handleMasterLevels(body) {
		if (body.length < MASTER_LEVELS_LENGTH) return
		const now = Date.now()
		this.master.channels = this.channelsFrom(MIX_ID, body, MASTER_POINTS, now)
		this.master.lastLevelAt = now
		this.lastFrameAt = now
	}

	/**
	 * One metering pair as the contract's three readings, with the three curves the
	 * drawing needs beside them.
	 */
	channelsFrom(key, body, points, now) {
		const pre = readPoint(body, points[PRE_POINT])
		const post = readPoint(body, points[POST_POINT])
		return post.map((channel, index) => {
			const outgoing = fromLevelField(channel.level)
			const incoming = fromLevelField(pre[index].level)
			return {
				loudness: outgoing,
				post: outgoing,
				pre: incoming,
				smoothedLoudness: this.loudness.reading(`${key}:out`, index, outgoing, now),
				fallingPeak: this.peakFall.reading(`${key}:out`, index, outgoing, now),
				fallingInputPeak: this.peakFall.reading(`${key}:in`, index, incoming, now),
			}
		})
	}

	handleEvent(name, body) {
		switch (name) {
			case SOURCE_PROPERTIES:
				this.handleSourceProperties(body)
				break

			case SOURCE_GONE:
				this.handleSourceGone(body)
				break

			case MASTER_PROPERTIES:
				if (body.length >= MASTER_PROPERTIES_LENGTH) {
					this.master.volume = fromLevelField(body.readInt32BE(AT_MASTER_FADER_GAIN))
					this.master.stages.equalizer = body.readUInt8(AT_MASTER_EQUALIZER_ENABLED) > 0
				}
				break

			case MASTER_COMPRESSOR:
				if (body.length >= MASTER_COMPRESSOR_LENGTH) {
					this.master.stages.compressor = body.readUInt8(AT_MASTER_STAGE_ENABLED) > 0
				}
				break

			case MASTER_LIMITER:
				if (body.length >= MASTER_LIMITER_LENGTH) {
					this.master.stages.limiter = body.readUInt8(AT_MASTER_STAGE_ENABLED) > 0
				}
				break

			case EXPANDER:
				this.patchStage(body, 'expander')
				break

			case COMPRESSOR:
				this.patchStage(body, 'compressor')
				break

			case LIMITER:
				this.patchStage(body, 'limiter')
				break

			case INPUT_PROPERTIES:
				this.handleInputProperties(body)
				break

			case TALLY:
				this.handleTally(body)
				break

			default:
				break
		}
	}

	handleSourceProperties(body) {
		if (body.length < SOURCE_PROPERTIES_LENGTH) {
			this.handlers.onLog('debug', 'a source arrived shorter than its properties')
			return
		}
		const index = body.readUInt16BE(AT_PROPERTIES_INDEX)
		const source = body.readBigInt64BE(AT_PROPERTIES_SOURCE)
		const id = `${index}.${source}`
		const known = this.sources.get(id)
		const entry = known ?? {
			index,
			source,
			channels: [],
			stages: {},
			lastLevelAt: undefined,
		}

		entry.mixOption = body.readUInt8(AT_MIX_OPTION)
		entry.volume = fromLevelField(body.readInt32BE(AT_FADER_GAIN))
		entry.stages.equalizer = body.readUInt8(AT_EQUALIZER_ENABLED) > 0

		this.sources.set(id, entry)
		if (!known) this.scheduleChanged()
	}

	handleSourceGone(body) {
		if (body.length < AT_PROPERTIES_SOURCE + 8) return
		const index = body.readUInt16BE(AT_PROPERTIES_INDEX)
		const id = `${index}.${body.readBigInt64BE(AT_PROPERTIES_SOURCE)}`
		if (!this.sources.delete(id)) return
		this.forgetMissing()
		this.scheduleChanged()
	}

	patchStage(body, stage) {
		if (body.length < STAGE_LENGTH) return
		const id = `${body.readUInt16BE(AT_STAGE_INDEX)}.${body.readBigInt64BE(AT_STAGE_SOURCE)}`
		const entry = this.sources.get(id)
		if (!entry) return
		entry.stages[stage] = body.readUInt8(AT_STAGE_ENABLED) > 0
	}

	handleInputProperties(body) {
		if (body.length < AT_INPUT_NAME + INPUT_NAME_LENGTH) return
		const inputId = body.readUInt16BE(AT_INPUT_ID)
		const name = readName(body, AT_INPUT_NAME, INPUT_NAME_LENGTH)
		if (this.names.get(inputId) === name) return
		this.names.set(inputId, name)
		this.scheduleChanged()
	}

	handleTally(body) {
		if (body.length < 2) return
		const count = body.readUInt16BE(0)
		if (2 + count * TALLY_ENTRY_LENGTH > body.length) return
		for (let index = 0; index < count; index++) {
			const at = 2 + index * TALLY_ENTRY_LENGTH
			const flags = body.readUInt8(at + 2)
			this.tally.set(body.readUInt16BE(at), { program: (flags & TALLY_PROGRAM) > 0 })
		}
	}

	/**
	 * Forget the curves being held for sources the switcher no longer has. The mix
	 * is never one of them and is never forgotten.
	 */
	forgetMissing() {
		const keep = (channel) => {
			const id = channel.slice(0, channel.indexOf(':'))
			return id === MIX_ID || this.sources.has(id)
		}
		this.loudness.forget(keep)
		this.peakFall.forget(keep)
	}
}

module.exports = { Source }
