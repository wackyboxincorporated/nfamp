export class S3MParser {
    constructor(buffer) {
        this.view = new DataView(buffer);
        this.offset = 0;
        this.type = 'S3M';
    }

    read8() { return this.offset < this.view.byteLength ? this.view.getUint8(this.offset++) : 0; }
    read16() { if (this.offset + 2 > this.view.byteLength) return 0; const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
    read32() { if (this.offset + 4 > this.view.byteLength) return 0; const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
    readString(len) {
        let s = '';
        const start = this.offset;
        for (let i = 0; i < len; i++) {
            const c = this.read8();
            if (c !== 0) s += String.fromCharCode(c);
        }
        this.offset = start + len;
        return s.trim();
    }
    seek(pos) { this.offset = Math.min(pos, this.view.byteLength); }

    parse() {
        this.seek(0);
        const name = this.readString(28);
        this.seek(0x1C);
        this.read8(); // EOF
        const type = this.read8();
        this.read16(); // reserved

        const songLength = this.read16();
        const sampleCount = this.read16();
        const patternCount = this.read16();
        const flags = this.read16();
        const trackerVersion = this.read16();
        const formatVersion = this.read16();

        const signature = this.readString(4);
        if (signature !== 'SCRM') throw new Error('Not a valid S3M');

        this.seek(0x30);
        const globalVolume = this.read8();
        const initialSpeed = this.read8();
        const initialBPM = this.read8();

        this.seek(0x60);
        const songOrder = [];
        for (let i = 0; i < songLength; i++) {
            const o = this.read8();
            if (o < 255) songOrder.push(o);
        }

        const sampleParapointers = [];
        for (let i = 0; i < sampleCount; i++) sampleParapointers.push(this.read16());

        const patternParapointers = [];
        for (let i = 0; i < patternCount; i++) patternParapointers.push(this.read16());

        const samples = sampleParapointers.map(ptr => this.parseSample(ptr));
        const patterns = patternParapointers.map(ptr => this.parsePattern(ptr));

        return {
            name,
            songLength: songOrder.length,
            songOrder,
            samples,
            patterns,
            channels: 32,
            initialSpeed: initialSpeed || 6,
            initialBPM: initialBPM || 125,
            globalVolume: globalVolume || 128,
            type: 'S3M'
        };
    }

    parseSample(ptr) {
        if (ptr === 0) return { name: '', length: 0 };
        const saved = this.offset;
        this.seek(ptr * 16);

        const type = this.read8();
        const filename = this.readString(12);
        const dataPtrHigh = this.read8();
        const dataPtrLow = this.read16();
        const length = this.read32();
        const loopStart = this.read32();
        const loopEnd = this.read32();
        const volume = this.read8();
        this.read8(); // Internal ass 
        const pack = this.read8();
        const flags = this.read8();
        const c2spd = this.read32();

        this.seek(this.offset + 12);
        const name = this.readString(28);
        const sig = this.readString(4);

        let data = null;
        if (type === 1 && sig === 'SCRS') {
            const dataOffset = (dataPtrHigh << 16 | dataPtrLow) * 16;
            const is16Bit = (flags & 4) !== 0;
            const dataLen = is16Bit ? length / 2 : length;

            if (dataOffset + length <= this.view.buffer.byteLength) {
                if (is16Bit) {
                    const raw = new Int16Array(this.view.buffer, dataOffset, dataLen);
                    data = new Float32Array(dataLen);
                    for (let i = 0; i < dataLen; i++) data[i] = raw[i] / 32768.0;
                } else {
                    const raw = new Uint8Array(this.view.buffer, dataOffset, length);
                    data = new Float32Array(length);
                    for (let i = 0; i < length; i++) data[i] = (raw[i] - 128) / 128.0;
                }
            }
        }

        this.offset = saved;
        return { name, length: data ? data.length : 0, volume, c2spd: c2spd || 8363, data, loopStart, loopLength: (flags & 1) ? (loopEnd - loopStart) : 0 };
    }

    parsePattern(ptr) {
        if (ptr === 0) return { rows: Array.from({ length: 64 }, () => []) };
        const saved = this.offset;
        this.seek(ptr * 16);
        const length = this.read16();
        const end = this.offset + length;
        const rows = Array.from({ length: 64 }, () => []);
        let row = 0;

        while (row < 64 && this.offset < end) {
            const b = this.read8();
            if (b === 0) { row++; continue; }
            const ch = b & 31;
            const n = { note: 255, sample: 0, volume: 255, effect: 255, param: 0 };
            if (b & 32) {
                const rawNote = this.read8();
                const rawSample = this.read8();
                if (rawNote < 254) n.note = (rawNote >> 4) * 12 + (rawNote & 0x0F);
                else n.note = rawNote;
                n.sample = rawSample;
            }
            if (b & 64) n.volume = this.read8();
            if (b & 128) { n.effect = this.read8(); n.param = this.read8(); }
            rows[row][ch] = n;
        }
        this.offset = saved;
        return { rows };
    }
}
