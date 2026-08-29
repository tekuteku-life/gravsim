
// gravsim_calc_quadtree.js

/*******************************************************************
 * QuadTree Data Structures for Spatial Partitioning
 *******************************************************************/
export class Rectangle {
	constructor(x, y, w, h) {
		this.x = x; // m
		this.y = y; // m
		this.w = w; // m
		this.h = h; // m
	}

	contains(obj) {
		return (obj.x >= this.x - this.w &&
				obj.x <= this.x + this.w &&
				obj.y >= this.y - this.h &&
				obj.y <= this.y + this.h);
	}

	intersects(range) {
		return !(range.x - range.w > this.x + this.w ||
				 range.x + range.w < this.x - this.w ||
				 range.y - range.h > this.y + this.h ||
				 range.y + range.h < this.y - this.h);
	}
}

/*******************************************************************
 * Zero-allocation Object Pool for QuadTree
 *******************************************************************/
export class QuadTreePool {
	constructor() {
		this.rects = [];
		this.rectsUsed = 0;
		this.trees = [];
		this.treesUsed = 0;
	}

	getRectangle(x, y, w, h) {
		if (this.rectsUsed >= this.rects.length) {
			this.rects.push(new Rectangle(x, y, w, h));
		}
		const r = this.rects[this.rectsUsed++];
		r.x = x; r.y = y; r.w = w; r.h = h;
		return r;
	}

	getTree(boundary, capacity) {
		if (this.treesUsed >= this.trees.length) {
			this.trees.push(new QuadTree(boundary, capacity, this));
		}
		const t = this.trees[this.treesUsed++];
		t.boundary = boundary;
		t.capacity = capacity;
		t.pool = this;
		t.objects.length = 0;
		t.divided = false;
		t.ne = null; t.nw = null; t.se = null; t.sw = null;
		return t;
	}

	reset() {
		this.rectsUsed = 0;
		this.treesUsed = 0;
	}
}

/*******************************************************************
 * QuadTree class
 *******************************************************************/
class QuadTree {
	constructor(boundary, capacity, pool) {
		this.boundary = boundary;
		this.capacity = capacity;
		this.pool = pool;
		this.objects = [];
		this.divided = false;
	}

	subdivide() {
		const x = this.boundary.x;
		const y = this.boundary.y;
		const w = this.boundary.w / 2;
		const h = this.boundary.h / 2;
		this.ne = this.pool.getTree(this.pool.getRectangle(x + w, y - h, w, h), this.capacity);
		this.nw = this.pool.getTree(this.pool.getRectangle(x - w, y - h, w, h), this.capacity);
		this.se = this.pool.getTree(this.pool.getRectangle(x + w, y + h, w, h), this.capacity);
		this.sw = this.pool.getTree(this.pool.getRectangle(x - w, y + h, w, h), this.capacity);
		this.divided = true;
	}

	insert(obj) {
		if (!this.boundary.contains(obj)) {
			return false;
		}

		if (this.objects.length < this.capacity) {
			this.objects.push(obj);
			return true;
		} else {
			if (!this.divided) {
				this.subdivide();
			}
			if (this.ne.insert(obj)) { return true; }
			if (this.nw.insert(obj)) { return true; }
			if (this.se.insert(obj)) { return true; }
			if (this.sw.insert(obj)) { return true; }
			return false;
		}
	}

	query(range, found) {
		if (!this.boundary.intersects(range)) {
			return found;
		}

		for (let p of this.objects) {
			if (range.contains(p)) {
				found.push(p);
			}
		}

		if (this.divided) {
			this.nw.query(range, found);
			this.ne.query(range, found);
			this.sw.query(range, found);
			this.se.query(range, found);
		}

		return found;
	}
}
