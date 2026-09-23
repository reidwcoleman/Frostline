// Queue of snow deformation stamps (ski tracks, footprints, paw prints, body craters).
// Producers call snow.stamp(...) as they move; the SnowTrails renderer drains the queue each frame.

export type StampKind = 'ski' | 'foot' | 'paw' | 'hoof' | 'body' | 'tree';

export interface SnowStamp {
  x: number;
  z: number;
  /** Heading of the mark (unit vector on the ground plane). */
  dirX: number;
  dirZ: number;
  width: number; // meters across
  length: number; // meters along dir
  depth: number; // 0..1 how deep
  kind: StampKind;
}

export class SnowMarks {
  private queue: SnowStamp[] = [];

  stamp(s: SnowStamp) {
    if (this.queue.length < 1024) this.queue.push(s);
  }

  drain(): SnowStamp[] {
    const q = this.queue;
    this.queue = [];
    return q;
  }
}
