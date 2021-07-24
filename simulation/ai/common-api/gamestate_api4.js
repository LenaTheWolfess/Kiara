var API3 = function(m)
{

m.GameState.prototype.getTechReq = function(techTemplateName)
{
	let res = [];
	if (this.playerData.disabledTechnologies[techTemplateName])
		return false;
	let template = this.getTemplate(techTemplateName);
	if (!template)
		return false;
	let reqs = template.requirements(this.playerData.civ);
	if (!reqs)
		return false;
	for (let req of reqs) {
		if (req["techs"] && req["techs"].length) {
			for (let tech of req["techs"]) {
				if (!this.playerData.researchedTechs.has(tech))
					res.push(tech);
			}
			break;
		}
	}

	return res;
};

/** This returns only units from buildings. */
m.GameState.prototype.findTrainableUnits = function(classes, anticlasses)
{
	let allTrainable = [];
	let civ = this.playerData.civ;
	this.getOwnTrainingFacilities().forEach(function(ent) {
		let trainable = ent.trainableEntities(civ);
		if (!trainable)
			return;
		for (let unit of trainable)
			if (allTrainable.indexOf(unit) === -1)
				allTrainable.push(unit);
	});
	let ret = [];
	let limits = this.getEntityLimits();
	let matchCounts = this.getEntityMatchCounts();
	let current = this.getEntityCounts();
	for (let trainable of allTrainable)
	{
		if (this.isTemplateDisabled(trainable))
			continue;
		let template = this.getTemplate(trainable);
		if (!template || !template.available(this))
			continue;
		if (classes.some(c => !template.hasClass(c)))
			continue;
		if (anticlasses.some(c => template.hasClass(c)))
			continue;
		let category = template.trainingCategory();
		if (category && limits[category] && current[category] >= limits[category])
			continue;
		let limit = template.matchLimit();
		if (matchCounts && limit && matchCounts[trainable] >= limit)
			continue;
		ret.push([trainable, template]);
	}
	return ret;
};

m.GameState.prototype.filterTrainableUnitsByClass = function(allTrainable, classes, anticlasses)
{
	let ret = [];
	let limits = this.getEntityLimits();
	let current = this.getEntityCounts();
	let matchCounts = this.getEntityMatchCounts();
	for (let trainable of allTrainable)
	{
		let template = this.getTemplate(trainable);
		if (classes.some(c => !template.hasClass(c)))
			continue;
		if (anticlasses.some(c => template.hasClass(c)))
			continue;
		let limit = template.matchLimit();
		if (matchCounts && limit && matchCounts[trainable] >= limit)
			continue;

		ret.push([trainable, template]);
	}
	return ret;
};

m.GameState.prototype.filterTrainableUnits = function(allTrainable)
{
	let ret = [];
	let limits = this.getEntityLimits();
	let current = this.getEntityCounts();
	let matchCounts = this.getEntityMatchCounts();
	for (let trainable of allTrainable)
	{
		if (this.isTemplateDisabled(trainable))
			continue;
		let template = this.getTemplate(trainable);
		if (!template || !template.available(this))
			continue;
		let category = template.trainingCategory();
		if (category && limits[category] && current[category] >= limits[category])
			continue;
		let limit = template.matchLimit();
		if (matchCounts && limit && matchCounts[trainable] >= limit)
			continue;

		ret.push(trainable);
	}
	return ret;
};

return m;

}(API3);

