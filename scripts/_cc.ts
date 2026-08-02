import { grinder } from '../src/lib/server/grinder/engine.ts';
import { makeSource } from '../src/lib/server/grinder/registry.ts';
const src = makeSource('coldcard')!;
console.log('source:', src.name, 'bucket:', src.bucket, 'spaceBits:', src.spaceBits.toFixed(1), 'size:', src.size?.toString());
await grinder.start(src);
await new Promise(r=>setTimeout(r, 5000));
await grinder.stop();
console.log('tried:', grinder.status.keysTried, 'keys/s:', Math.round(grinder.status.keysPerSec));
