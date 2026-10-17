/**
 * Session log zstd artifact surgery. The shipped format is a concatenation of
 * independent zstd frames: frame 0 is the header line, every event is its own
 * frame (verified against live v4 logs and against `scanZstdFrames` in
 * `@deepseek-ai/dsh-session-persistence-jsonl`). Rewriting the header therefore
 * only rebuilds frame 0; every event frame is carried over byte-for-byte, which
 * keeps the operation cheap and reversible for arbitrarily large logs.
 */
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

export const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC_MIN = 0x184d2a50, SKIPPABLE_MAGIC_MAX = 0x184d2a5f;
// The shipped writer puts an XXH64 content checksum on every frame; match it so
// the rewritten header is indistinguishable in style from the original.
const CHECKSUM = { [constants.ZSTD_c_checksumFlag]: 1 };

/**
 * Walk a frame sequence exactly like the official scanner (including skippable
 * frames). Throws on any malformed byte — the walk IS the post-write validation.
 * @param buffer - complete artifact bytes.
 * @returns ordered frames with byte ranges.
 */
export function scanFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) throw new Error(`truncated zstd artifact: fewer than 4 bytes at ${offset}`);
		const magic = buffer.readUInt32LE(offset);
		if (magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX) {
			const size = buffer.readUInt32LE(offset + 4);
			offset += 8 + size;
			if (offset > buffer.length) throw new Error(`truncated skippable frame at ${start}`);
			continue;
		}
		if (magic !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
		offset += 4;
		if (offset === buffer.length) throw new Error(`frame header missing at byte ${start}`);
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
		const remaining = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remaining) throw new Error(`truncated frame header at byte ${start}`);
		offset += remaining;
		for (;;) {
			if (buffer.length - offset < 3) throw new Error(`truncated block header at byte ${offset}`);
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = blockHeader >>> 1 & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) throw new Error(`truncated block payload at byte ${offset}`);
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) throw new Error(`truncated frame checksum at byte ${offset}`);
			offset += 4;
		}
		frames.push({ start, end: offset });
	}
	return frames;
}

export function decodeFrame(buffer, frame) {
	return zstdDecompressSync(buffer.subarray(frame.start, frame.end));
}

/** Parse the header line of a session artifact (first non-skippable frame). */
export function readHeader(buffer) {
	const frames = scanFrames(buffer);
	if (frames.length === 0) throw new Error('empty zstd artifact');
	const text = decodeFrame(buffer, frames[0]).toString('utf8').trim();
	const header = JSON.parse(text);
	if (header.type !== 'session' || typeof header.id !== 'string') throw new Error('malformed session header frame');
	return { header, frames };
}

/**
 * Produce a complete artifact whose header frame carries a replaced cwd. The
 * header object keeps its original key order; only the `cwd` value changes
 * (`undefined` removes the field). All remaining frames are copied verbatim.
 * @param buffer - original artifact bytes.
 * @param nextCwd - canonical project directory for the moved session, or undefined.
 * @returns rewritten bytes.
 */
export function rewriteHeaderFrame(buffer, nextCwd) {
	const { header, frames } = readHeader(buffer);
	const updated = { ...header };
	if (nextCwd === undefined) delete updated.cwd;
	else updated.cwd = nextCwd;
	if (JSON.stringify(updated) === JSON.stringify(header)) return Buffer.from(buffer);
	const frame0 = zstdCompressSync(Buffer.from(`${JSON.stringify(updated)}\n`, 'utf8'), { params: CHECKSUM });
	scanFrames(frame0); // re-verify our own output before it ever touches the store
	return Buffer.concat([frame0, buffer.subarray(frames[0].end)]);
}
