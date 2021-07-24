var API3 = function(m)
{

/** Shared script handling templates and basic terrain analysis */


m.SharedScript.prototype.getMetadata = function(player, ent, key)
{
	let metadata = this._entityMetadata[player][ent.id()];
	return metadata && metadata[key];
};

return m;

}(API3);

