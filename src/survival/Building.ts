// PLACEHOLDER building system (owned by the survival/building agent).
import type { GameContext, System } from '../core/types';
import { BUILD_PIECES, type BuildPieceDef, type BuildPieceId } from '../core/data';

export class Building implements System {
  readonly name = 'building';
  readonly pieces: BuildPieceDef[] = BUILD_PIECES;
  placing: BuildPieceId | null = null;
  constructor(private ctx: GameContext) {}
  /** Enter placement mode with a ghost preview of the piece. */
  begin(piece: BuildPieceId) {
    this.placing = piece;
    void this.ctx;
  }
  cancel() {
    this.placing = null;
  }
}
