var API3 = function(m)
{

/** Shared script handling templates and basic terrain analysis */


m.SharedScript.prototype.getMetadata = function(player, ent, key)
{
	let metadata = this._entityMetadata[player][ent.id()];
	return metadata && metadata[key];
};

m.SharedScript.prototype.changeEntityInResourceMapHelper = function(ent, multiplication = 1)
{
	if (!ent)
		return;
	const entPos = ent.position();
	if (!entPos)
		return;
	const resource = ent.resourceSupplyType()?.generic;
	if (!resource || !this.resourceMaps[resource])
		return;
	if (resource == "food" && ent.resourceSupplyType()?.specific != "fruit")
		return;
	const cellSize = this.resourceMaps[resource].cellSize;
	const x = Math.floor(entPos[0] / cellSize);
	const y = Math.floor(entPos[1] / cellSize);
	const grp = Resources.GetResource(resource).aiAnalysisInfluenceGroup;
	const strength = multiplication * ent.resourceSupplyMax() / this.normalizationFactor[grp];
	this.resourceMaps[resource].addInfluence(x, y, this.influenceRadius[grp] / cellSize, strength / 2, "constant");
	this.resourceMaps[resource].addInfluence(x, y, this.influenceRadius[grp] / cellSize, strength / 2);
	this.ccResourceMaps[resource].addInfluence(x, y, this.ccInfluenceRadius[grp] / cellSize, strength, "constant");
};

return m;

}(API3);

