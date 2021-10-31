var API3 = function(m)
{

m.EntityCollection.prototype.regroup = function(queued = false)
{
	Engine.PostCommand(PlayerID, {"type": "regroup", "entities": this.toIdArray(), "queued": queued});
	return this;
};

m.EntityCollection.prototype.form = function(name , queued = false)
{
	Engine.PostCommand(PlayerID, {"type": "formation", "entities": this.toIdArray(), "formation": name, "queued": queued});
	return this;
};

m.EntityCollection.prototype.stopMoving = function()
{
	Engine.PostCommand(PlayerID, { "type": "stop", "entities": this.toIdArray(), "queued": false });
};


m.EntityCollection.prototype.moveToRange_api4 = function(func, x, z, min, max, queued = false, pushFront = false)
{
	let cmd = {
		"type": "walk-to-range",
		"entities": this.toIdArray(),
		"x": x,
		"z": z,
		"min": min,
		"max": max,
		"queued": queued,
		"pushFront": pushFront
	};
//	warn("function[" + func + "]: " + uneval(cmd));
	Engine.PostCommand(PlayerID, cmd);
	return this;
};

return m;

}(API3);
