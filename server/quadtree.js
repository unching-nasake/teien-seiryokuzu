/**
 * 空間インデックス（Quadtree）
 * 隣接タイル検索を高速化するためのデータ構造
 */

const MAP_SIZE = 500;
const MAX_ITEMS_PER_NODE = 10;
const MAX_DEPTH = 8;

class QuadTree {
  constructor(bounds, depth = 0) {
    this.bounds = bounds; // { x, y, width, height }
    this.depth = depth;
    this.items = []; // { key, x, y, data }
    this.children = null; // [NW, NE, SW, SE]
  }

  /**
   * タイルを挿入
   */
  insert(key, x, y, data) {
    // 範囲外
    if (!this._contains(x, y)) return false;

    // 子ノードがある場合は適切な子に挿入
    if (this.children) {
      return this._insertIntoChild(key, x, y, data);
    }

    // 現在のノードに追加
    this.items.push({ key, x, y, data });

    // 分割が必要な場合
    if (this.items.length > MAX_ITEMS_PER_NODE && this.depth < MAX_DEPTH) {
      this._subdivide();
    }

    return true;
  }

  /**
   * タイルを削除
   */
  remove(key) {
    const index = this.items.findIndex((item) => item.key === key);
    if (index !== -1) {
      this.items.splice(index, 1);
      return true;
    }

    if (this.children) {
      for (const child of this.children) {
        if (child.remove(key)) return true;
      }
    }

    return false;
  }

  /**
   * 範囲内のタイルを取得
   */
  query(bounds) {
    const result = [];

    // 範囲が交差しない
    if (!this._intersects(bounds)) return result;

    // 現在ノードのアイテムをチェック
    for (const item of this.items) {
      if (
        item.x >= bounds.x &&
        item.x < bounds.x + bounds.width &&
        item.y >= bounds.y &&
        item.y < bounds.y + bounds.height
      ) {
        result.push(item);
      }
    }

    // 子ノードを再帰的に検索
    if (this.children) {
      for (const child of this.children) {
        result.push(...child.query(bounds));
      }
    }

    return result;
  }

  /**
   * 隣接タイルを高速取得（8方向）
   */
  getNeighbors(x, y, radius = 1) {
    return this.query({
      x: x - radius,
      y: y - radius,
      width: radius * 2 + 1,
      height: radius * 2 + 1,
    }).filter((item) => !(item.x === x && item.y === y));
  }

  /**
   * 全タイルをクリアして再構築
   */
  rebuild(tiles) {
    this.items = [];
    this.children = null;

    Object.entries(tiles).forEach(([key, tile]) => {
      const [x, y] = key.split("_").map(Number);
      this.insert(key, x, y, tile);
    });
  }

  // プライベートメソッド
  _contains(x, y) {
    return (
      x >= this.bounds.x &&
      x < this.bounds.x + this.bounds.width &&
      y >= this.bounds.y &&
      y < this.bounds.y + this.bounds.height
    );
  }

  _intersects(bounds) {
    return !(
      bounds.x >= this.bounds.x + this.bounds.width ||
      bounds.x + bounds.width <= this.bounds.x ||
      bounds.y >= this.bounds.y + this.bounds.height ||
      bounds.y + bounds.height <= this.bounds.y
    );
  }

  _subdivide() {
    const { x, y, width, height } = this.bounds;
    const halfW = width / 2;
    const halfH = height / 2;

    this.children = [
      new QuadTree({ x, y, width: halfW, height: halfH }, this.depth + 1), // NW
      new QuadTree(
        { x: x + halfW, y, width: halfW, height: halfH },
        this.depth + 1,
      ), // NE
      new QuadTree(
        { x, y: y + halfH, width: halfW, height: halfH },
        this.depth + 1,
      ), // SW
      new QuadTree(
        { x: x + halfW, y: y + halfH, width: halfW, height: halfH },
        this.depth + 1,
      ), // SE
    ];

    // 既存アイテムを子ノードに移動
    for (const item of this.items) {
      this._insertIntoChild(item.key, item.x, item.y, item.data);
    }
    this.items = [];
  }

  _insertIntoChild(key, x, y, data) {
    for (const child of this.children) {
      if (child._contains(x, y)) {
        return child.insert(key, x, y, data);
      }
    }
    return false;
  }
}

/**
 * マップ用Quadtreeインスタンスを作成
 */
function createMapQuadTree() {
  return new QuadTree({ x: 0, y: 0, width: MAP_SIZE, height: MAP_SIZE });
}

module.exports = {
  QuadTree,
  createMapQuadTree,
  MAP_SIZE,
};
