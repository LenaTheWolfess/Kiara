var API3 = function(m)
{

/**
 * The map module.
 * Copied with changes from QuantumState's original for qBot, it's a component for storing 8 bit values.
 */

m.Map.prototype.setInfluence = function(cx, cy, min, max, strength)
{
	let x0 = Math.floor(Math.max(0, cx - max));
	let y0 = Math.floor(Math.max(0, cy - max));
	let x1 = Math.floor(Math.min(this.width-1, cx + max));
	let y1 = Math.floor(Math.min(this.height-1, cy + max));
	let maxDist2 = max * max;
	let minDist2 = min * min;
	for (let y = y0; y < y1; ++y)
	{
		let dy = y - cy;
		for (let x = x0; x < x1; ++x)
		{
			let dx = x - cx;
			let r2 = dx*dx + dy*dy;
			if (r2 >= maxDist2)
				continue;
			if (r2 <= minDist2)
				continue;
			let w = x + y * this.width;
			this.set(w, strength);
		}
	}
};

return m;

}(API3);
