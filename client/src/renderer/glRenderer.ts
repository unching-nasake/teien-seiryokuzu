import {
  DEFAULT_BOARD_SIZE,
  FactionSummary,
  OverlayMode,
  PALETTE_RGB_FLOAT,
} from '../shared/protocol';
import { sabLoadSeq, sabReadSeq } from '../shared/sab';
import { FRAGMENT_SHADER_SRC, VERTEX_SHADER_SRC } from './shaders';

export interface CameraState {
  cx: number;
  cy: number;
  zoom: number;
}

export class BoardGLRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private boardTex!: WebGLTexture;
  private factionTex!: WebGLTexture;
  private factionMetaBuf = new Uint8Array(256 * 256 * 4);

  private uResolution!: WebGLUniformLocation;
  private uCamOffset!: WebGLUniformLocation;
  private uZoom!: WebGLUniformLocation;
  private uTime!: WebGLUniformLocation;
  private uOverlayMode!: WebGLUniformLocation;
  private uShowCoreMarker!: WebGLUniformLocation;
  private uHoverCell!: WebGLUniformLocation;
  private uSelectedCell!: WebGLUniformLocation;
  private uHighlightFaction!: WebGLUniformLocation;
  private uHoverAccent!: WebGLUniformLocation;
  private uBoardSize!: WebGLUniformLocation;
  private uMaxLayers!: WebGLUniformLocation;
  private uAssimilationReq!: WebGLUniformLocation;

  public boardSize = DEFAULT_BOARD_SIZE;
  private _maxLayers = 10;
  private _assimilationRequiredTicks = 10;
  public camera: CameraState = { cx: DEFAULT_BOARD_SIZE / 2, cy: DEFAULT_BOARD_SIZE / 2, zoom: 2.0 };
  private _overlayMode: OverlayMode = 0;
  private _showCoreMarker = true;
  private _hoverX = -1;
  private _hoverY = -1;
  private _selectedX = -1;
  private _selectedY = -1;
  private _highlightFactionId = 0;
  private _hoverAccent: [number, number, number] = [0.98, 0.96, 0.75];
  public onAfterRender?: () => void;
  public onContextRestored?: () => void;
  /** 外部（2D キャンバス等）で継続アニメーションが進行中かを返すコールバック */
  public hasExternalAnimation?: () => boolean;

  private rafId = 0;
  private rafRunning = false;
  private needsRender = true;
  private hasWarFactions = false;
  private startTime = performance.now();
  private disposed = false;
  private contextLost = false;
  private maxTextureSize = 2048;
  private cachedCssWidth = 1;
  private cachedCssHeight = 1;
  private lastDpr = 0;
  private dprMediaQuery: MediaQueryList | null = null;
  private resizeObserver?: ResizeObserver;
  private needsInitialFit = false;
  private pendingUpload: { gpuTex: Uint8Array; boardSize: number; ctrl?: Int32Array } | null = null;
  private pendingDirtyRect: {
    gpuTex: Uint8Array;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    ctrl?: Int32Array;
  } | null = null;
  /** SeqLock 検証中に共有メモリから安全にスナップショットを退避するための非共有ステージングバッファ */
  private stagingBuf = new Uint8Array(0);

  public get maxLayers(): number {
    return this._maxLayers;
  }
  public set maxLayers(v: number) {
    if (this._maxLayers !== v) {
      this._maxLayers = v;
      this.requestRender();
    }
  }

  public get assimilationRequiredTicks(): number {
    return this._assimilationRequiredTicks;
  }
  public set assimilationRequiredTicks(v: number) {
    if (this._assimilationRequiredTicks !== v) {
      this._assimilationRequiredTicks = v;
      this.requestRender();
    }
  }

  public get overlayMode(): OverlayMode {
    return this._overlayMode;
  }
  public set overlayMode(v: OverlayMode) {
    if (this._overlayMode !== v) {
      this._overlayMode = v;
      this.requestRender();
    }
  }

  public get showCoreMarker(): boolean {
    return this._showCoreMarker;
  }
  public set showCoreMarker(v: boolean) {
    if (this._showCoreMarker !== v) {
      this._showCoreMarker = v;
      this.requestRender();
    }
  }

  public get hoverX(): number {
    return this._hoverX;
  }
  public set hoverX(v: number) {
    if (this._hoverX !== v) {
      this._hoverX = v;
      this.requestRender();
    }
  }

  public get hoverY(): number {
    return this._hoverY;
  }
  public set hoverY(v: number) {
    if (this._hoverY !== v) {
      this._hoverY = v;
      this.requestRender();
    }
  }

  public get selectedX(): number {
    return this._selectedX;
  }
  public set selectedX(v: number) {
    if (this._selectedX !== v) {
      this._selectedX = v;
      this.requestRender();
    }
  }

  public get selectedY(): number {
    return this._selectedY;
  }
  public set selectedY(v: number) {
    if (this._selectedY !== v) {
      this._selectedY = v;
      this.requestRender();
    }
  }

  public get highlightFactionId(): number {
    return this._highlightFactionId;
  }
  public set highlightFactionId(v: number) {
    if (this._highlightFactionId !== v) {
      this._highlightFactionId = v;
      this.requestRender();
    }
  }

  public get hoverAccent(): [number, number, number] {
    return this._hoverAccent;
  }
  public set hoverAccent(v: [number, number, number]) {
    if (
      this._hoverAccent[0] !== v[0] ||
      this._hoverAccent[1] !== v[1] ||
      this._hoverAccent[2] !== v[2]
    ) {
      this._hoverAccent = v;
      this.requestRender();
    }
  }

  /** キャッシュ済みの CSS ピクセルサイズを返す（Forced Reflow 回避用） */
  public getCssSize(): { width: number; height: number } {
    return { width: this.cachedCssWidth, height: this.cachedCssHeight };
  }

  private handleVisibilityChange = (): void => {
    if (!document.hidden && !this.disposed && !this.contextLost) {
      this.requestRender();
    }
  };

  /** ウィンドウが別 DPR のモニターへ移動した際などに静止中でも解像度を即時追従させる */
  private handleDprChange = (): void => {
    if (this.disposed) return;
    this.watchDevicePixelRatio();
    this.resize();
  };

  private unwatchDevicePixelRatio(): void {
    const mq = this.dprMediaQuery;
    if (!mq) return;
    this.dprMediaQuery = null;
    if (typeof mq.removeEventListener === 'function') {
      mq.removeEventListener('change', this.handleDprChange);
    } else if (typeof mq.removeListener === 'function') {
      mq.removeListener(this.handleDprChange);
    }
  }

  private watchDevicePixelRatio(): void {
    this.unwatchDevicePixelRatio();
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const dpr = window.devicePixelRatio || 1;
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', this.handleDprChange);
    } else if (typeof mq.addListener === 'function') {
      mq.addListener(this.handleDprChange);
    }
    this.dprMediaQuery = mq;
  }

  private handleContextLost = (e: Event): void => {
    e.preventDefault();
    if (this.disposed) return;
    this.contextLost = true;
    // コンテキストロスト中は保留中のテクスチャアップロードを破棄する
    this.pendingUpload = null;
    this.pendingDirtyRect = null;
  };

  private handleContextRestored = (): void => {
    if (this.disposed) return;
    try {
      // リソース再構築が完全に成功した場合のみコンテキストロスト状態を解除する
      this.initGLResources();
      this.contextLost = false;
      this.resize();
      this.requestRender();
    } catch (err) {
      this.contextLost = true;
      console.error('[BoardGLRenderer] WebGL コンテキスト復元に失敗しました:', err);
      return;
    }
    // 外部コールバックの例外で contextLost 状態へ戻さないよう分離して実行する
    try {
      this.onContextRestored?.();
    } catch (err) {
      console.error('[BoardGLRenderer] コンテキスト復元コールバックでエラーが発生しました:', err);
    }
  };

  constructor(canvas: HTMLCanvasElement, initialBoardSize = DEFAULT_BOARD_SIZE) {
    this.canvas = canvas;

    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      throw new Error('お使いのブラウザは WebGL2 に対応していません');
    }
    this.gl = gl;

    const maxTex = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    this.maxTextureSize = Number.isInteger(maxTex) && maxTex > 0 ? maxTex : 2048;
    if (!this.isValidBoardSize(initialBoardSize)) {
      throw new RangeError(
        `不正な盤面サイズです: ${initialBoardSize}（1〜${this.maxTextureSize} の整数である必要があります）`
      );
    }
    this.boardSize = initialBoardSize;

    this.canvas.addEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);

    try {
      this.initGLResources();
    } catch (err) {
      this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
      this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
      throw err;
    }

    this.watchDevicePixelRatio();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        if (!this.disposed) {
          this.resize();
          // 初回マウント時に 0 サイズだった場合は有効サイズになった瞬間に 1 回だけフィットさせる
          if (this.needsInitialFit && this.cachedCssWidth > 1 && this.cachedCssHeight > 1) {
            this.fitBoard();
            this.needsInitialFit = false;
          }
        }
      });
      this.resizeObserver.observe(this.canvas);
    }

    const initialRect = this.canvas.getBoundingClientRect();
    if (initialRect.width <= 0 || initialRect.height <= 0) {
      this.needsInitialFit = true;
    }

    this.resize();
    this.fitBoard();
    this.requestRender();
  }

  /** シェーダー・VAO・テクスチャ・Uniform ロケーションを初期化（コンテキスト復元時にも再利用） */
  private initGLResources(): void {
    const gl = this.gl;
    const maxTex = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    if (Number.isInteger(maxTex) && maxTex > 0) {
      this.maxTextureSize = maxTex;
    }
    let program: WebGLProgram | null = null;
    let vao: WebGLVertexArrayObject | null = null;
    let boardTex: WebGLTexture | null = null;
    let factionTex: WebGLTexture | null = null;

    try {
      program = this.createProgram(VERTEX_SHADER_SRC, FRAGMENT_SHADER_SRC);
      gl.useProgram(program);

      vao = gl.createVertexArray();
      if (!vao) throw new Error('VAO の作成に失敗しました');
      gl.bindVertexArray(vao);

      // 盤面テクスチャ (boardSize × boardSize RGBA8UI)
      boardTex = gl.createTexture();
      if (!boardTex) throw new Error('盤面テクスチャの作成に失敗しました');
      this.allocateBoardTexture(this.boardSize, boardTex);

      // 勢力メタデータテクスチャ (256×256 RGBA8UI)
      factionTex = gl.createTexture();
      if (!factionTex) throw new Error('勢力テクスチャの作成に失敗しました');
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, factionTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8UI,
        256,
        256,
        0,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_BYTE,
        this.factionMetaBuf
      );

      gl.uniform1i(gl.getUniformLocation(program, 'u_boardTex'), 0);
      gl.uniform1i(gl.getUniformLocation(program, 'u_factionTex'), 1);
      gl.uniform3fv(gl.getUniformLocation(program, 'u_palette'), PALETTE_RGB_FLOAT);

      this.uResolution = gl.getUniformLocation(program, 'u_resolution')!;
      this.uCamOffset = gl.getUniformLocation(program, 'u_camOffset')!;
      this.uZoom = gl.getUniformLocation(program, 'u_zoom')!;
      this.uTime = gl.getUniformLocation(program, 'u_time')!;
      this.uOverlayMode = gl.getUniformLocation(program, 'u_overlayMode')!;
      this.uShowCoreMarker = gl.getUniformLocation(program, 'u_showCoreMarker')!;
      this.uHoverCell = gl.getUniformLocation(program, 'u_hoverCell')!;
      this.uSelectedCell = gl.getUniformLocation(program, 'u_selectedCell')!;
      this.uHighlightFaction = gl.getUniformLocation(program, 'u_highlightFaction')!;
      this.uHoverAccent = gl.getUniformLocation(program, 'u_hoverAccent')!;
      this.uBoardSize = gl.getUniformLocation(program, 'u_boardSize')!;
      this.uMaxLayers = gl.getUniformLocation(program, 'u_maxLayers')!;
      this.uAssimilationReq = gl.getUniformLocation(program, 'u_assimilationReq')!;

      // すべてのリソースと Uniform 取得が成功した後にのみインスタンスへ反映する
      this.program = program;
      this.vao = vao;
      this.boardTex = boardTex;
      this.factionTex = factionTex;
    } catch (err) {
      if (factionTex) gl.deleteTexture(factionTex);
      if (boardTex) gl.deleteTexture(boardTex);
      if (vao) gl.deleteVertexArray(vao);
      if (program) gl.deleteProgram(program);
      throw err;
    }
  }

  private isValidBoardSize(size: number): boolean {
    return Number.isInteger(size) && size > 0 && size <= this.maxTextureSize;
  }

  private resetInteractionAndPendingUpload(): void {
    this.pendingUpload = null;
    this.pendingDirtyRect = null;
    this._hoverX = -1;
    this._hoverY = -1;
    this._selectedX = -1;
    this._selectedY = -1;
    this._highlightFactionId = 0;
  }

  private allocateBoardTexture(size: number, targetTex: WebGLTexture = this.boardTex): void {
    if (this.disposed) return;
    if (!this.isValidBoardSize(size)) {
      throw new Error(`盤面サイズが WebGL テクスチャ上限を超えています: ${size}`);
    }
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targetTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8UI,
      size,
      size,
      0,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_BYTE,
      null
    );
  }

  /** 盤面サイズ変更時（または強制再確保時）に VRAM テクスチャを再確保しカメラをフィットさせる */
  public resizeBoard(newSize: number, force = false): void {
    if (this.disposed || !this.isValidBoardSize(newSize)) return;
    if (this.boardSize === newSize && !force) {
      // 同サイズ再確保時でも旧バッファ向けの保留アップロードと選択状態を破棄する
      this.resetInteractionAndPendingUpload();
      this.requestRender();
      return;
    }
    this.resetInteractionAndPendingUpload();
    if (newSize < this.boardSize) {
      this.stagingBuf = new Uint8Array(0);
    }
    this.boardSize = newSize;
    if (!this.contextLost) {
      this.allocateBoardTexture(newSize);
    }
    this.fitBoard();
  }

  /** 同一サイズでの盤面再読込時に保留アップロード・選択状態・VRAM テクスチャをリセットする */
  public resetForBoardReload(): void {
    this.resizeBoard(this.boardSize, true);
  }

  private createProgram(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSrc);
    let fs: WebGLShader;
    try {
      fs = this.compileShader(gl.FRAGMENT_SHADER, fsSrc);
    } catch (err) {
      gl.deleteShader(vs);
      throw err;
    }

    const prog = gl.createProgram();
    if (!prog) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new Error('シェーダープログラムの作成に失敗しました');
    }

    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new Error(`シェーダーリンク失敗: ${log}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return prog;
  }

  private compileShader(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) {
      throw new Error('シェーダーオブジェクトの作成に失敗しました');
    }
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`シェーダーコンパイル失敗: ${log}`);
    }
    return shader;
  }

  public resize(): void {
    if (this.disposed) return;
    const rect = this.canvas.getBoundingClientRect();
    this.cachedCssWidth = Math.max(1, rect.width);
    this.cachedCssHeight = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.lastDpr = dpr;
    const w = Math.max(1, Math.floor(this.cachedCssWidth * dpr));
    const h = Math.max(1, Math.floor(this.cachedCssHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (!this.contextLost) {
      // ドライバによりバックバッファが縮小クランプされた場合でも実寸に合わせる
      const dbW = Math.max(1, this.gl.drawingBufferWidth);
      const dbH = Math.max(1, this.gl.drawingBufferHeight);
      this.gl.viewport(0, 0, dbW, dbH);
      this.requestRender();
    }
  }

  private getMinZoom(): number {
    const minSide = Math.max(200, Math.min(this.cachedCssWidth, this.cachedCssHeight));
    return Math.min(0.4, (minSide * 0.85) / Math.max(1, this.boardSize));
  }

  /** 盤面全体が収まる初期ズームへ調整 */
  public fitBoard(): void {
    const minSide = Math.max(200, Math.min(this.cachedCssWidth, this.cachedCssHeight));
    this.camera.cx = this.boardSize / 2;
    this.camera.cy = this.boardSize / 2;
    this.camera.zoom = Math.min(
      48,
      Math.max(this.getMinZoom(), (minSide * 0.9) / Math.max(1, this.boardSize))
    );
    this.requestRender();
  }

  /** 必要バイト長以上の再利用可能な非共有ステージングビューを返す */
  private ensureStagingCapacity(requiredBytes: number): Uint8Array {
    if (this.stagingBuf.byteLength < requiredBytes) {
      this.stagingBuf = new Uint8Array(requiredBytes);
    }
    return this.stagingBuf.subarray(0, requiredBytes);
  }

  /** SAB SeqLock の偶数・前後一致を確認しつつ非共有ステージングへ CPU コピーを実行 */
  private copyWithSeqLock(ctrl: Int32Array, copyFn: () => void): boolean {
    for (let attempt = 0; attempt < 8; attempt++) {
      let seq1 = sabLoadSeq(ctrl);
      // 書き込み中（奇数）であれば短スピンして完了を待つ
      for (let spin = 0; spin < 256 && (seq1 & 1) !== 0; spin++) {
        seq1 = sabLoadSeq(ctrl);
      }
      // スピン上限後も書き込み中なら不整合データをコピーせず再試行する
      if ((seq1 & 1) !== 0) {
        continue;
      }
      copyFn();
      const seq2 = sabReadSeq(ctrl);
      if (seq1 === seq2) {
        return true;
      }
    }
    return false;
  }

  /** 盤面全体の RGBA8UI テクスチャを VRAM へ転送 */
  public uploadFullBoard(gpuTex: Uint8Array, boardSize: number, ctrl?: Int32Array): void {
    if (this.contextLost || this.disposed) return;
    if (!this.isValidBoardSize(boardSize)) return;
    if (gpuTex.byteLength !== boardSize * boardSize * 4) return;
    if (boardSize !== this.boardSize) {
      this.resizeBoard(boardSize);
    }

    let uploadData: Uint8Array;
    if (ctrl) {
      const staging = this.ensureStagingCapacity(gpuTex.byteLength);
      const ok = this.copyWithSeqLock(ctrl, () => {
        staging.set(gpuTex);
      });
      if (!ok) {
        // 競合時は VRAM へ書き込まず次フレーム先頭で再試行する
        this.pendingUpload = { gpuTex, boardSize: this.boardSize, ctrl };
        this.requestRender();
        return;
      }
      uploadData = staging;
    } else {
      uploadData = gpuTex;
    }

    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.boardTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.boardSize,
      this.boardSize,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_BYTE,
      uploadData
    );
    this.pendingUpload = null;
    this.pendingDirtyRect = null;
    this.requestRender();
  }

  /** 変更があった最小包含矩形を予約し、次フレーム先頭で 1 回にマージして VRAM へ部分更新 */
  public uploadDirtyRect(
    gpuTex: Uint8Array,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    ctrl?: Int32Array
  ): void {
    if (this.contextLost || this.disposed) return;
    if (
      !Number.isInteger(minX) ||
      !Number.isInteger(minY) ||
      !Number.isInteger(maxX) ||
      !Number.isInteger(maxY) ||
      minX < 0 ||
      minY < 0 ||
      maxX >= this.boardSize ||
      maxY >= this.boardSize ||
      minX > maxX ||
      minY > maxY
    ) {
      return;
    }
    if (gpuTex.byteLength !== this.boardSize * this.boardSize * 4) return;
    if (this.pendingUpload) {
      // フル再アップロード予約中はそちらを優先する
      return;
    }

    if (this.pendingDirtyRect && this.pendingDirtyRect.gpuTex === gpuTex) {
      this.pendingDirtyRect.minX = Math.min(this.pendingDirtyRect.minX, minX);
      this.pendingDirtyRect.minY = Math.min(this.pendingDirtyRect.minY, minY);
      this.pendingDirtyRect.maxX = Math.max(this.pendingDirtyRect.maxX, maxX);
      this.pendingDirtyRect.maxY = Math.max(this.pendingDirtyRect.maxY, maxY);
      this.pendingDirtyRect.ctrl = ctrl;
    } else {
      this.pendingDirtyRect = { gpuTex, minX, minY, maxX, maxY, ctrl };
    }
    this.requestRender();
  }

  /** 予約済みの部分更新矩形を 1 回の texSubImage2D で VRAM へ転送 */
  private flushDirtyRect(
    gpuTex: Uint8Array,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    ctrl?: Int32Array
  ): void {
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    if (width <= 0 || height <= 0) return;

    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.boardTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    if (ctrl) {
      const rectBytes = width * height * 4;
      const staging = this.ensureStagingCapacity(rectBytes);
      const rowBytes = width * 4;
      const srcStride = this.boardSize * 4;
      const ok = this.copyWithSeqLock(ctrl, () => {
        let srcOff = (minY * this.boardSize + minX) * 4;
        let dstOff = 0;
        for (let y = 0; y < height; y++) {
          staging.set(gpuTex.subarray(srcOff, srcOff + rowBytes), dstOff);
          srcOff += srcStride;
          dstOff += rowBytes;
        }
      });
      if (!ok) {
        this.pendingUpload = { gpuTex, boardSize: this.boardSize, ctrl };
        this.requestRender();
        return;
      }
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        minX,
        minY,
        width,
        height,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_BYTE,
        staging
      );
      return;
    }

    try {
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, this.boardSize);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, minX);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, minY);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        minX,
        minY,
        width,
        height,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_BYTE,
        gpuTex
      );
    } finally {
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    }
  }

  public updateFactionMetadata(
    factions: FactionSummary[],
    myFactionId: number,
    warFactionIds: Set<number>
  ): void {
    if (this.disposed) return;
    this.hasWarFactions = myFactionId > 0 && warFactionIds.size > 0;
    this.factionMetaBuf.fill(0);
    for (const f of factions) {
      if (f.id <= 0 || f.id > 65535) continue;
      const off = f.id * 4;
      let relation = 0;
      if (f.id === myFactionId) {
        relation = 1;
      } else if (warFactionIds.has(f.id)) {
        relation = 2;
      }
      this.factionMetaBuf[off] = relation;
      this.factionMetaBuf[off + 1] = f.color_id & 0x3f;
      this.factionMetaBuf[off + 2] = f.is_extinct ? 1 : 0;
      this.factionMetaBuf[off + 3] = 255;
    }
    // コンテキストロスト中は CPU バッファのみ更新し、復元時に initGLResources 側で一括転送する
    if (this.contextLost) return;

    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.factionTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      256,
      256,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_BYTE,
      this.factionMetaBuf
    );
    this.requestRender();
  }

  public screenToBoard(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = rect.width > 0 ? rect.width : this.cachedCssWidth;
    const cssH = rect.height > 0 ? rect.height : this.cachedCssHeight;
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const bx = this.camera.cx + (sx - cssW * 0.5) / this.camera.zoom;
    const by = this.camera.cy + (sy - cssH * 0.5) / this.camera.zoom;
    return { x: Math.floor(bx), y: Math.floor(by) };
  }

  public zoomAt(clientX: number, clientY: number, factor: number): void {
    if (
      this.disposed ||
      !Number.isFinite(clientX) ||
      !Number.isFinite(clientY) ||
      !Number.isFinite(factor) ||
      factor <= 0
    ) {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const cssW = rect.width > 0 ? rect.width : this.cachedCssWidth;
    const cssH = rect.height > 0 ? rect.height : this.cachedCssHeight;
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const halfW = cssW * 0.5;
    const halfH = cssH * 0.5;
    const beforeX = this.camera.cx + (sx - halfW) / this.camera.zoom;
    const beforeY = this.camera.cy + (sy - halfH) / this.camera.zoom;

    const minZoom = this.getMinZoom();
    const nextZoom = Math.min(48, Math.max(minZoom, this.camera.zoom * factor));
    this.needsInitialFit = false;
    this.camera.zoom = nextZoom;
    this.camera.cx = beforeX - (sx - halfW) / nextZoom;
    this.camera.cy = beforeY - (sy - halfH) / nextZoom;
    this.clampCamera();
    this.requestRender();
  }

  public panBy(dxPx: number, dyPx: number): void {
    if (this.disposed || !Number.isFinite(dxPx) || !Number.isFinite(dyPx)) return;
    this.needsInitialFit = false;
    this.camera.cx -= dxPx / this.camera.zoom;
    this.camera.cy -= dyPx / this.camera.zoom;
    this.clampCamera();
    this.requestRender();
  }

  /** 指定盤面座標へカメラを移動（任意でズームも変更） */
  public focusOn(cx: number, cy: number, targetZoom?: number): void {
    if (this.disposed || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
    this.needsInitialFit = false;
    if (targetZoom !== undefined && Number.isFinite(targetZoom) && targetZoom > 0) {
      const minZoom = this.getMinZoom();
      this.camera.zoom = Math.min(48, Math.max(minZoom, targetZoom));
    }
    this.camera.cx = cx;
    this.camera.cy = cy;
    this.clampCamera();
    this.requestRender();
  }

  /** 現在の表示範囲（盤面座標系）を取得 */
  public getViewportBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    const halfW = (this.cachedCssWidth * 0.5) / this.camera.zoom;
    const halfH = (this.cachedCssHeight * 0.5) / this.camera.zoom;
    return {
      minX: this.camera.cx - halfW,
      minY: this.camera.cy - halfH,
      maxX: this.camera.cx + halfW,
      maxY: this.camera.cy + halfH,
    };
  }

  private clampCamera(): void {
    const pad = Math.max(20, this.boardSize * 0.08);
    this.camera.cx = Math.min(this.boardSize + pad, Math.max(-pad, this.camera.cx));
    this.camera.cy = Math.min(this.boardSize + pad, Math.max(-pad, this.camera.cy));
  }

  /** 点滅や波紋エフェクト等の連続アニメーションが必要か判定 */
  private needsContinuousAnimation(): boolean {
    return (
      this._overlayMode === 3 ||
      this.hasWarFactions ||
      this._highlightFactionId > 0 ||
      (this._selectedX >= 0 && this._selectedY >= 0) ||
      (this._hoverX >= 0 && this._hoverY >= 0) ||
      Boolean(this.hasExternalAnimation?.()) ||
      this.pendingUpload !== null ||
      this.pendingDirtyRect !== null
    );
  }

  /** 再描画を予約する（静止時は rAF ループを自動停止し GPU/バッテリー消費を抑制） */
  public requestRender(): void {
    this.needsRender = true;
    if (this.disposed || this.contextLost || document.hidden || this.rafRunning) {
      return;
    }
    this.rafRunning = true;
    this.rafId = requestAnimationFrame(this.onFrame);
  }

  private onFrame = (now: number): void => {
    this.rafRunning = false;
    if (this.disposed || document.hidden || this.contextLost) return;

    if (this.needsRender || this.needsContinuousAnimation()) {
      this.needsRender = false;
      const elapsedSec = Math.max(0, (now - this.startTime) * 0.001);
      this.render(elapsedSec);
      this.onAfterRender?.();
    }

    if (!this.disposed && !document.hidden && !this.contextLost) {
      if (this.needsRender || this.needsContinuousAnimation()) {
        this.rafRunning = true;
        this.rafId = requestAnimationFrame(this.onFrame);
      }
    }
  };

  private render(elapsedSec: number): void {
    if (this.contextLost || this.disposed) return;
    const currentDpr = Math.min(window.devicePixelRatio || 1, 2);
    if (currentDpr !== this.lastDpr) {
      this.resize();
    }
    // SeqLock 競合で保留されていたフル再アップロードをフレーム先頭で 1 回だけ試行する
    if (this.pendingUpload) {
      const pending = this.pendingUpload;
      this.pendingUpload = null;
      this.pendingDirtyRect = null;
      this.uploadFullBoard(pending.gpuTex, pending.boardSize, pending.ctrl);
    } else if (this.pendingDirtyRect) {
      const dirty = this.pendingDirtyRect;
      this.pendingDirtyRect = null;
      this.flushDirtyRect(dirty.gpuTex, dirty.minX, dirty.minY, dirty.maxX, dirty.maxY, dirty.ctrl);
    }
    const gl = this.gl;
    const cssW = Math.max(1, this.cachedCssWidth);
    const cssH = Math.max(1, this.cachedCssHeight);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    // シェーダの閾値判定・座標変換を CSS ピクセル基準（screenToBoard と同一）に揃える
    gl.uniform2f(this.uResolution, cssW, cssH);
    gl.uniform2f(this.uCamOffset, this.camera.cx, this.camera.cy);
    gl.uniform1f(this.uZoom, this.camera.zoom);
    gl.uniform1f(this.uTime, elapsedSec);
    gl.uniform1i(this.uOverlayMode, this._overlayMode);
    gl.uniform1i(this.uShowCoreMarker, this._showCoreMarker ? 1 : 0);
    gl.uniform2i(this.uHoverCell, this._hoverX, this._hoverY);
    gl.uniform2i(this.uSelectedCell, this._selectedX, this._selectedY);
    gl.uniform1ui(this.uHighlightFaction, this._highlightFactionId);
    gl.uniform3f(
      this.uHoverAccent,
      this._hoverAccent[0],
      this._hoverAccent[1],
      this._hoverAccent[2]
    );
    gl.uniform1i(this.uBoardSize, this.boardSize);
    gl.uniform1i(this.uMaxLayers, this._maxLayers);
    gl.uniform1i(this.uAssimilationReq, this._assimilationRequiredTicks);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  public dispose(): void {
    this.disposed = true;
    this.rafRunning = false;
    cancelAnimationFrame(this.rafId);
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.unwatchDevicePixelRatio();
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.pendingUpload = null;
    this.pendingDirtyRect = null;
    this.stagingBuf = new Uint8Array(0);
    this.onAfterRender = undefined;
    this.onContextRestored = undefined;
    this.hasExternalAnimation = undefined;
    const gl = this.gl;
    gl.deleteTexture(this.boardTex);
    gl.deleteTexture(this.factionTex);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
