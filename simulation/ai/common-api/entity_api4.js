var API3 = function(m)
{

m.Template.prototype.alertRaiser = function() {
	return !!this.get("AlertRaiser");
};

m.Template.prototype.attackRange = function(type) {
	if (!this.get("Attack/" + type +""))
		return undefined;

	return {
		"max": +this.get("Attack/" + type +"/MaxRange"),
		"min": +(this.get("Attack/" + type +"/MinRange") || 0),
		"elevationBonus": +(this.get("Attack/" + type + "/ElevationBonus") || 0)
	};
};

m.Entity.prototype.api4_counters = function(target) {
	const attack = this.get("Attack");
	const def = target.resistanceStrengths();
	if (!attack)
		return false;
	let mcounter = [];
	let lowest = undefined;
	if (def.Damage) {
		for (let type in attack) {
			if (!lowest || def.Damage[type] < lowest)
				lowest = type;
		}
	}
	let counterLowest = false;
	for (let type in attack)
	{
		counterLowest = type == lowest || counterLowest;
		let bonuses = this.get("Attack/" + type + "/Bonuses");
		if (!bonuses)
			continue;
		for (let b in bonuses)
		{
			let bonusClasses = this.get("Attack/" + type + "/Bonuses/" + b + "/Classes");
			if (bonusClasses)
				mcounter.concat(bonusClasses.split(" "));
		}
	}
	return counterLowest || target.hasClasses(mcounter);
};

m.Entity.prototype.raiseAlert = function() {
	if (!this.alertRaiser())
		return undefined;
	Engine.PostCommand(PlayerID, {"type": "alert-raise", "entities": [this.id()]});
	return this;
};

m.Entity.prototype.endAlert = function() {
	if (!this.alertRaiser())
		return undefined;
	Engine.PostCommand(PlayerID, {"type": "alert-end", "entities": [this.id()]});
	return this;
};

m.Entity.prototype.upgradeCost = function(upgrade) {
	if (!this.get("Upgrade"))
		return undefined;
	if (!this.get("Upgrade/"+upgrade))
		return undefined;
	if (!this.get("Upgrade/"+upgrade+"/Cost"))
		return {};
	let ret = {};
	for (let type in this.get("Upgrade/"+upgrade+"/Cost/Resources"))
		ret[type] = +this.get("Upgrade/"+upgrade+"/Cost/Resources/" + type);
	return ret;
};

m.Entity.prototype.upgradeTemplate = function(upgrade) {
	if (!this.get("Upgrade"))
		return undefined;
	if (!this.get("Upgrade/"+upgrade))
		return undefined;
	return this.get("Upgrade/"+upgrade+"/Entity");
};

m.Entity.prototype.upgrade = function(template) {
	Engine.PostCommand(PlayerID, { "type": "upgrade", "entities": [this.id()], "template": template });
	return this;
};

return m;

}(API3);