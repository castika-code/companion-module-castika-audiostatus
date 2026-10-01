#!/usr/bin/env node
/**
 * Measures a switcher's audio and prints a report. It listens; it sends the
 * subscription that asks for levels and nothing else, and no path in this file
 * changes a setting on the desk.
 *
 * Run it as: node tools/atem-probe.mjs <address> [seconds]
 *
 * It reads the command bodies itself rather than through the adapter, because
 * what it is here to question is the offsets.
 */

import { AtemConnection } from '../src/sources/atemprotocol.js'

// How long the run lasts when no length is given.
const DEFAULT_SECONDS = 30

// How long the level feed may stop before the run calls the subscription spent.
const FEED_GAP_MS = 2000

// A level field read three ways: as it stands, as hundredths of a decibel, and as
// a fraction of the largest value the field can hold.
const FULL_SCALE_FIELD = 32768

// Where each reading sits in a source's level command.
const SOURCE_POINTS = {
	input: { level: 10, peak: 14 },
	output: { level: 24, peak: 28 },
	third: { level: 32, peak: 36 },
}
const SOURCE_REDUCTIONS = { expander: 18, compressor: 20, limiter: 22 }
const SOURCE_LEVELS_LENGTH = 40

// The same for the master out, which carries no expander.
const MASTER_POINTS = {
	input: { level: 0, peak: 4 },
	output: { level: 12, peak: 16 },
	third: { level: 20, peak: 24 },
}
const MASTER_REDUCTIONS = { compressor: 8, limiter: 10 }
const MASTER_LEVELS_LENGTH = 28

// Where each fact sits in a source's properties command.
const AT_PROPERTIES_INDEX = 0
const AT_PROPERTIES_SOURCE = 8
const AT_SOURCE_TYPE = 16
const AT_EQUALIZER_ENABLED = 29
const AT_FADER_GAIN = 44
const AT_SUPPORTED_MIX_OPTIONS = 48
const AT_MIX_OPTION = 49
const SOURCE_PROPERTIES_LENGTH = 50

// Where the enabled flag sits in a dynamics stage's command.
const AT_STAGE_INDEX = 0
const AT_STAGE_SOURCE = 8
const AT_STAGE_ENABLED = 16
const STAGE_LENGTH = 17

// An input's name and the room it is given.
const AT_INPUT_ID = 0
const AT_INPUT_NAME = 2
const INPUT_NAME_LENGTH = 20

// A routed output's own name and the room it is given.
const AT_ROUTING_OUTPUT_ID = 0
const AT_ROUTING_SOURCE_ID = 4
const AT_ROUTING_NAME = 12
const ROUTING_NAME_LENGTH = 64

const TALLY_ENTRY_LENGTH = 3

// What the three states of a source's mix option are called.
const MIX_OPTIONS = { 1: 'off', 2: 'on', 4: 'follows video' }

const LEVEL_COMMANDS = new Set(['FMLv', 'FDLv'])

const [, , address, seconds] = process.argv
if (!address) {
	console.error('usage: node tools/atem-probe.mjs <address> [seconds]')
	process.exit(2)
}
const runFor = Number(seconds) > 0 ? Number(seconds) * 1000 : DEFAULT_SECONDS * 1000

const report = {
	startedAt: Date.now(),
	connectedAt: undefined,
	product: undefined,
	version: undefined,
	failures: new Map(),
	commands: new Map(),
	sources: new Map(),
	master: undefined,
	frameTimes: [],
	frameSeenAt: new Map(),
	masterFrames: 0,
	sourceFrames: 0,
	subscribedAt: undefined,
	lastFrameAt: undefined,
	firstGap: undefined,
	routingOutputs: new Map(),
	inputNames: new Map(),
	tallySources: 0,
	identifiersChangedAt: undefined,
}

function readName(body, at, length) {
	const end = Math.min(at + length, body.length)
	const text = body.toString('utf8', at, end)
	const stop = text.indexOf('\u0000')
	return stop === -1 ? text : text.slice(0, stop)
}

function span(held, value) {
	if (!held) return { low: value, high: value, last: value }
	return { low: Math.min(held.low, value), high: Math.max(held.high, value), last: value }
}

function readPoints(body, points) {
	const read = {}
	for (const [name, place] of Object.entries(points)) {
		read[name] = {
			level: [body.readInt16BE(place.level), body.readInt16BE(place.level + 2)],
			peak: [body.readInt16BE(place.peak), body.readInt16BE(place.peak + 2)],
		}
	}
	return read
}

function readReductions(body, places) {
	const read = {}
	for (const [name, at] of Object.entries(places)) read[name] = body.readInt16BE(at)
	return read
}

/** Fold one frame's readings into the spans held for that source. */
function foldFrame(held, points, reductions) {
	for (const [name, pair] of Object.entries(points)) {
		const place = (held.points[name] ??= { level: [], peak: [] })
		pair.level.forEach((value, index) => (place.level[index] = span(place.level[index], value)))
		pair.peak.forEach((value, index) => (place.peak[index] = span(place.peak[index], value)))
	}
	for (const [name, value] of Object.entries(reductions)) {
		held.reductions[name] = span(held.reductions[name], value)
	}
	held.frames++
}

function blankLevels(bodyLength) {
	return { frames: 0, points: {}, reductions: {}, bodyLength }
}

function countCommand(name, body) {
	const held = report.commands.get(name)
	if (held) {
		held.count++
		if (!held.lengths.includes(body.length)) held.lengths.push(body.length)
		return
	}
	report.commands.set(name, { count: 1, lengths: [body.length] })
}

/**
 * Note that one feed produced a reading. The gap is kept per feed, because every
 * source and the master arrive together in one packet and the gaps between them
 * inside it are not a cadence.
 */
function noteFrame(key) {
	const now = Date.now()
	const before = report.frameSeenAt.get(key)
	if (before !== undefined) {
		const gap = now - before
		report.frameTimes.push(gap)
		if (gap > FEED_GAP_MS && report.firstGap === undefined) {
			report.firstGap = { after: before - report.subscribedAt, gap }
		}
	}
	report.frameSeenAt.set(key, now)
	report.lastFrameAt = now
}

function handleSourceLevels(body) {
	if (body.length < SOURCE_LEVELS_LENGTH) return
	const index = body.readUInt16BE(8)
	const source = body.readBigInt64BE(0)
	const id = `${index}.${source}`
	const held = report.sources.get(id) ?? { index, source, levels: undefined, properties: undefined, stages: {} }
	held.levels ??= blankLevels(body.length)
	foldFrame(held.levels, readPoints(body, SOURCE_POINTS), readReductions(body, SOURCE_REDUCTIONS))
	report.sources.set(id, held)
	report.sourceFrames++
	noteFrame(id)
}

function handleMasterLevels(body) {
	if (body.length < MASTER_LEVELS_LENGTH) return
	report.master ??= blankLevels(body.length)
	foldFrame(report.master, readPoints(body, MASTER_POINTS), readReductions(body, MASTER_REDUCTIONS))
	report.masterFrames++
	noteFrame('master')
}

function handleSourceProperties(body) {
	if (body.length < SOURCE_PROPERTIES_LENGTH) return
	const index = body.readUInt16BE(AT_PROPERTIES_INDEX)
	const source = body.readBigInt64BE(AT_PROPERTIES_SOURCE)
	const id = `${index}.${source}`
	const held = report.sources.get(id) ?? { index, source, levels: undefined, properties: undefined, stages: {} }
	const properties = {
		sourceType: body.readUInt8(AT_SOURCE_TYPE),
		equalizerEnabled: body.readUInt8(AT_EQUALIZER_ENABLED) > 0,
		faderGain: body.readInt32BE(AT_FADER_GAIN),
		supportedMixOptions: body.readUInt8(AT_SUPPORTED_MIX_OPTIONS),
		mixOption: body.readUInt8(AT_MIX_OPTION),
		bodyLength: body.length,
	}
	if (held.properties && held.properties.mixOption !== properties.mixOption) {
		held.mixOptionMoved = true
	}
	held.properties = properties
	if (!report.sources.has(id) && report.connectedAt !== undefined) {
		report.identifiersChangedAt ??= Date.now()
	}
	report.sources.set(id, held)
}

function handleStage(body, stage) {
	if (body.length < STAGE_LENGTH) return
	const id = `${body.readUInt16BE(AT_STAGE_INDEX)}.${body.readBigInt64BE(AT_STAGE_SOURCE)}`
	const held = report.sources.get(id)
	if (!held) return
	held.stages[stage] = { enabled: body.readUInt8(AT_STAGE_ENABLED) > 0, bodyLength: body.length }
}

const connection = new AtemConnection({
	onStatus(state, message) {
		if (state === 'connected') {
			report.connectedAt = Date.now()
			report.subscribedAt = Date.now()
			connection.watchLevels(true)
			return
		}
		if (state === 'failed') report.failures.set(message, (report.failures.get(message) ?? 0) + 1)
	},
	onLevels(name, body) {
		countCommand(name, body)
		if (name === 'FMLv') handleSourceLevels(body)
		else handleMasterLevels(body)
	},
	onEvent(name, body) {
		countCommand(name, body)
		switch (name) {
			case '_pin':
				report.product = readName(body, 0, body.length)
				break
			case '_ver':
				if (body.length >= 4) report.version = `${body.readUInt16BE(0)}.${body.readUInt16BE(2)}`
				break
			case 'FASP':
				handleSourceProperties(body)
				break
			case 'AIXP':
				handleStage(body, 'expander')
				break
			case 'AICP':
				handleStage(body, 'compressor')
				break
			case 'AILP':
				handleStage(body, 'limiter')
				break
			case 'InPr':
				if (body.length >= AT_INPUT_NAME + INPUT_NAME_LENGTH) {
					report.inputNames.set(body.readUInt16BE(AT_INPUT_ID), readName(body, AT_INPUT_NAME, INPUT_NAME_LENGTH))
				}
				break
			case 'AROP':
				if (body.length >= AT_ROUTING_NAME) {
					const outputId = body.readUInt32BE(AT_ROUTING_OUTPUT_ID)
					report.routingOutputs.set(outputId, {
						name: readName(body, AT_ROUTING_NAME, ROUTING_NAME_LENGTH),
						sourceId: body.readUInt32BE(AT_ROUTING_SOURCE_ID),
					})
				}
				break
			case 'TlSr':
				if (body.length >= 2) report.tallySources = body.readUInt16BE(0)
				break
			default:
				break
		}
	},
})

// The subscription is sent once and left alone, so that the run measures whether
// it has to be renewed rather than hiding the answer.
connection.renewEvery = 0

const SUBSCRIPTION_ONLY = 'SFLN'

console.log('')
console.log('  This probe only listens. It asks the desk to send audio levels and')
console.log(`  sends no other command. The one command it sends is ${SUBSCRIPTION_ONLY}, a request for`)
console.log('  data. No fader, mute, route, name or setting on the desk is changed.')
console.log('')
console.log(`  address ${address}   run ${Math.round(runFor / 1000)} s`)
console.log('')

connection.connect({ atemHost: address })

setTimeout(() => {
	connection.watchLevels(false)
	connection.close()
	print()
	process.exit(report.connectedAt === undefined ? 1 : 0)
}, runFor)

function decibelReadings(raw) {
	const asIs = raw
	const hundredths = raw / 100
	const linear = raw > 0 ? 20 * Math.log10(raw / FULL_SCALE_FIELD) : -Infinity
	return `${String(raw).padStart(7)}  ->  ${asIs.toFixed(1).padStart(8)} dB | ${hundredths
		.toFixed(2)
		.padStart(8)} dB | ${(Number.isFinite(linear) ? linear.toFixed(2) : '-inf').padStart(8)} dB`
}

function median(values) {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.floor(sorted.length / 2)]
}

function heading(text) {
	console.log('')
	console.log(text)
	console.log('-'.repeat(text.length))
}

function spanText(held) {
	if (!held) return '      -'
	return `${String(held.last).padStart(7)} (${held.low} to ${held.high})`
}

function printPoints(levels, label) {
	console.log(`  ${label}  frames ${levels.frames}, command body ${levels.bodyLength} bytes`)
	for (const [name, place] of Object.entries(levels.points)) {
		place.level.forEach((held, index) => {
			const peak = place.peak[index]
			console.log(`    ${name.padEnd(7)} ch${index}  level ${spanText(held)}   peak ${spanText(peak)}`)
		})
	}
	const reductions = Object.entries(levels.reductions)
	if (reductions.length > 0) {
		console.log(`    gain reduction  ${reductions.map(([name, held]) => `${name} ${spanText(held)}`).join('   ')}`)
	}
}

function print() {
	const ran = Math.round((Date.now() - report.startedAt) / 1000)

	heading('The desk')
	if (report.connectedAt === undefined) {
		console.log(`  No switcher answered at ${address} in ${ran} s.`)
		for (const [message, count] of report.failures) console.log(`  ${message} (${count} times)`)
		console.log('')
		console.log('  Nothing below was measured. Check the address and that the desk is on.')
		return
	}
	console.log(`  product            ${report.product ?? 'not reported'}`)
	console.log(`  protocol version   ${report.version ?? 'not reported'}`)
	console.log(`  state dump         arrived in sequence, so the packet header is read correctly`)
	console.log(`  ran for            ${ran} s`)
	for (const [message, count] of report.failures) console.log(`  interruption       ${message} (${count} times)`)

	heading('How often levels arrive')
	console.log(`  source frames      ${report.sourceFrames}`)
	console.log(`  master frames      ${report.masterFrames}`)
	console.log(`  median gap         ${median(report.frameTimes)} ms`)
	console.log(`  worst gap          ${report.frameTimes.length > 0 ? Math.max(...report.frameTimes) : 0} ms`)

	heading('Does the subscription have to be renewed')
	if (report.sourceFrames + report.masterFrames === 0) {
		console.log('  No levels arrived at all, so the subscription was not answered.')
	} else if (report.firstGap) {
		console.log(`  The feed stopped ${Math.round(report.firstGap.after / 1000)} s after one subscription was sent,`)
		console.log(`  with a gap of ${report.firstGap.gap} ms. It has to be renewed inside that time.`)
	} else {
		console.log(`  One subscription kept the feed arriving for the whole ${ran} s run.`)
		console.log('  Nothing here shows a renewal is needed within that time.')
	}

	heading('What a level field is')
	const range = fieldRange()
	if (range === undefined) {
		console.log('  No level arrived to read.')
	} else {
		console.log(`  every level field seen ran from ${range.low} to ${range.high}`)
		console.log('')
		console.log('      raw          as decibels | as hundredths | as a fraction of full field')
		console.log(`  ${decibelReadings(range.high)}   the loudest`)
		console.log(`  ${decibelReadings(range.low)}   the quietest`)
		console.log('')
		if (range.high <= 0) {
			console.log('  No field was positive, so a linear scale is ruled out and the field is')
			console.log('  decibels in one of the two fixed point forms above.')
		}
		console.log('  Against a known tone on the desk, one of the readings is right.')
	}

	heading('Is there a master reading of its own')
	if (report.master) {
		console.log('  Yes. The master out is metered separately from the sources.')
		printPoints(report.master, 'master out')
	} else {
		console.log('  No master level command arrived during the run.')
	}

	heading('Every metering point each source reports')
	console.log('  Move one fader during the run: the point whose span is widest is the')
	console.log('  one that follows it.')
	for (const [id, held] of sortedSources()) {
		console.log('')
		console.log(`  ${id}  ${report.inputNames.get(held.index) ?? '(unnamed)'}`)
		if (held.levels) printPoints(held.levels, 'levels')
		else console.log('    no levels arrived for this source')
	}

	heading('What identifies each source')
	console.log('  input   source id                hex                 name')
	for (const [id, held] of sortedSources()) {
		const hex = BigInt.asUintN(64, held.source).toString(16).padStart(16, '0')
		console.log(
			`  ${String(held.index).padEnd(7)} ${String(held.source).padEnd(23)} ${hex}  ${
				report.inputNames.get(held.index) ?? '(unnamed)'
			}   [${id}]`
		)
	}
	console.log('')
	if (report.identifiersChangedAt === undefined) {
		console.log('  No source appeared or changed id after the state dump, so the pair of')
		console.log('  numbers looks stable for a run.')
	} else {
		console.log('  A source appeared after the state dump, so the identifiers move.')
	}

	heading('The mix option of each source')
	console.log('  source          mix option      supported   fader gain   equalizer')
	for (const [id, held] of sortedSources()) {
		const properties = held.properties
		if (!properties) continue
		const option = MIX_OPTIONS[properties.mixOption] ?? `unknown ${properties.mixOption}`
		console.log(
			`  ${id.padEnd(15)} ${option.padEnd(15)} 0x${properties.supportedMixOptions
				.toString(16)
				.padStart(2, '0')
				.padEnd(8)} ${String(properties.faderGain).padStart(10)}   ${properties.equalizerEnabled ? 'on' : 'off'}`
		)
	}
	console.log('')
	console.log(`  A source whose option moved during the run: ${movedOptions() || 'none'}`)

	heading('Do the dynamics report an enabled flag')
	let anyStage = false
	for (const [id, held] of sortedSources()) {
		const stages = Object.entries(held.stages)
		if (stages.length === 0) continue
		anyStage = true
		console.log(
			`  ${id.padEnd(15)} ${stages
				.map(([name, stage]) => `${name} ${stage.enabled ? 'on' : 'off'} (${stage.bodyLength} bytes)`)
				.join('   ')}`
		)
	}
	if (!anyStage) console.log('  No dynamics command arrived, so no stage reported an enabled flag.')

	heading('Where audio can go')
	if (report.routingOutputs.size === 0) {
		console.log('  The desk named no routed audio output, so the only destination it')
		console.log('  described is the master out, which program follows.')
	} else {
		console.log('  output id   feeding source id   name as the desk gives it')
		for (const [outputId, output] of report.routingOutputs) {
			console.log(
				`  ${String(outputId).padEnd(11)} ${String(output.sourceId).padEnd(19)} ${output.name || '(unnamed)'}`
			)
		}
		console.log('')
		console.log('  Audio is routed to these separately, so which one the stream takes')
		console.log('  has to become a setting.')
	}
	console.log(`  video sources the tally covers: ${report.tallySources}`)

	heading('Every command the desk sent')
	console.log('  Anything here that is not read above is something nobody expected.')
	console.log('  command   count     body lengths')
	for (const [name, held] of [...report.commands].sort((a, b) => b[1].count - a[1].count)) {
		const mark = LEVEL_COMMANDS.has(name) ? '*' : ' '
		console.log(`  ${mark}${name.padEnd(8)} ${String(held.count).padStart(7)}     ${held.lengths.join(', ')}`)
	}
	console.log('')
}

function sortedSources() {
	return [...report.sources.entries()].sort((a, b) => a[1].index - b[1].index || (a[1].source < b[1].source ? -1 : 1))
}

function movedOptions() {
	return [...report.sources.values()]
		.filter((held) => held.mixOptionMoved)
		.map((held) => held.index)
		.join(', ')
}

/** How far every level field seen ran, which is what rules a reading in or out. */
function fieldRange() {
	let range
	const consider = (levels) => {
		if (!levels) return
		for (const place of Object.values(levels.points)) {
			for (const seen of [...place.level, ...place.peak]) {
				if (!seen) continue
				if (range === undefined) range = { low: seen.low, high: seen.high }
				else range = { low: Math.min(range.low, seen.low), high: Math.max(range.high, seen.high) }
			}
		}
	}
	consider(report.master)
	for (const held of report.sources.values()) consider(held.levels)
	return range
}
