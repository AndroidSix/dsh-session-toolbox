/**
 * Test-only zstd frame builder matching the shipped session-log writer: every
 * frame carries an XXH64 content checksum (descriptor bit + trailing 8 bytes),
 * produced by the same zlib Node bundles as the host.
 */
import { constants, zstdCompressSync } from 'node:zlib';

const CHECKSUM = constants.ZSTD_c_checksumFlag;

/** Compress one text chunk into a checksummed zstd frame. */
export function checksummedFrame(text) {
	return zstdCompressSync(Buffer.from(text, 'utf8'), { params: { [CHECKSUM]: 1 } });
}

/** Assemble a session artifact: one header frame + one frame per event line. */
export function sessionArtifact(header, events = []) {
	return Buffer.concat([checksummedFrame(`${JSON.stringify(header)}\n`),
		...events.map(line => checksummedFrame(line))]);
}
