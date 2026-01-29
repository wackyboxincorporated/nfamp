export class ModParser {
    constructor(buffer) {
        this.view = new DataView(buffer);
        this.offset = 0;
    }

    parse() {
        this.offset = 0x438; // ignature
        const signature = this.readString(4);
        const channels = this.getChannelCount(signature);

        // look 4 The fucking header thingmagic workkl3quowmo3mt
        if (!['M.K.', 'M!K!', '4CHN', '6CHN', '8CHN'].includes(signature) && !/^\d+CH$/.test(signature)) {
            throw new Error('Not a valid ProTracker MOD file');
        }

        this.offset = 0;
        const name = this.readString(20);

        const samples = [];
        for (let i = 0; i < 31; i++) {
            samples.push(this.parseSampleHeader());
        }

        const songLength = this.view.getUint8(this.offset++);
        this.offset++; // Skte

        const patternOrder = [];
        let maxPattern = 0;
        for (let i = 0; i < 128; i++) {
            const p = this.view.getUint8(this.offset++);
            patternOrder.push(p);
            if (p > maxPattern) maxPattern = p;
        }

        this.offset += 4; // Skdy read it

        const patterns = [];
        for (let i = 0; i <= maxPattern; i++) {
            patterns.push(this.parsePattern(channels));
        }

        for (let i = 0; i < 31; i++) {
            const sample = samples[i];
            if (sample && sample.length > 0) {
                const data = new Int8Array(this.view.buffer, this.offset, sample.length);
                sample.data = data;
                this.offset += sample.length;
            }
        }

        return {
            name,
            samples,
            songLength,
            patternOrder: patternOrder.slice(0, songLength),
            patterns,
            channels,
            type: 'MOD'
        };
    }

    readString(len) {
        let str = '';
        for (let i = 0; i < len; i++) {
            if (this.offset >= this.view.byteLength) break;
            const char = this.view.getUint8(this.offset++);
            if (char !== 0) str += String.fromCharCode(char);
        }
        return str.trim();
    }

    parseSampleHeader() {
        const name = this.readString(22);
        const length = this.view.getUint16(this.offset) * 2;
        this.offset += 2;

        const finetune = this.view.getUint8(this.offset++) & 0x0F;
        const volume = Math.min(64, this.view.getUint8(this.offset++));

        const loopStart = this.view.getUint16(this.offset) * 2;
        this.offset += 2;

        const loopLength = this.view.getUint16(this.offset) * 2;
        this.offset += 2;

        return {
            name,
            length,
            finetune,
            volume,
            loopStart,
            loopLength,
            data: null
        };
    }

    getChannelCount(sig) {
        switch (sig) {
            case 'M.K.':
            case 'M!K!':
            case '4CHN':
            case 'FLT4':
                return 4;
            case '6CHN':
                return 6;
            case '8CHN':
            case 'FLT8':
                return 8;
            default:
                if (sig.endsWith('CH')) {
                    const ch = parseInt(sig);
                    if (!isNaN(ch)) return ch;
                }
                return 4;
        }
    }

    parsePattern(channels) {
        const rows = [];
        for (let r = 0; r < 64; r++) {
            const row = [];
            for (let c = 0; c < channels; c++) {
                const b0 = this.view.getUint8(this.offset++);
                const b1 = this.view.getUint8(this.offset++);
                const b2 = this.view.getUint8(this.offset++);
                const b3 = this.view.getUint8(this.offset++);

                const sample = (b0 & 0xF0) | (b2 >> 4);
                const period = ((b0 & 0x0F) << 8) | b1;
                const effect = b2 & 0x0F;
                const effectParam = b3;

                row.push({ sample, period, effect, effectParam });
            }
            rows.push(row);
        }
        return { rows };
    }
}
