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

return m;

}(API3);
