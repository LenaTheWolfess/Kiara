KIARA.UpgradePlan = function(gameState, ent, upgrade, metadata)
{
	if (!KIARA.QueuePlan.call(this, gameState, ent.upgradeTemplate(upgrade), metadata))
		return false;

	this.entId = ent.id();
	this.category = "upgrade";
	this.upgrade = upgrade;
	this.cost = new API3.Resources(ent.upgradeCost(this.upgrade));

	return true;
};

KIARA.UpgradePlan.prototype = Object.create(KIARA.QueuePlan.prototype);

KIARA.UpgradePlan.prototype.canStart = function(gameState)
{
	if (!this.isGo(gameState))
		return false;

	if (this.template.requiredTech() && !gameState.isResearched(this.template.requiredTech()))
		return false;

	return true;
};

KIARA.UpgradePlan.prototype.start = function(gameState)
{
	Engine.ProfileStart("Upgrade start");
	let ent = gameState.getEntityById(this.entId);
	if (!ent) {
		Engine.ProfileStop();
		return;
	}
	ent.upgrade(this.template.templateName());
	this.onStart(gameState);
	Engine.ProfileStop();
};

KIARA.UpgradePlan.prototype.isGo = function(gameState)
{
	return !this.allreadyStarted();
};

KIARA.UpgradePlan.prototype.onStart = function(gameState)
{
	if (this.queueToReset)
		gameState.ai.queueManager.changePriority(this.queueToReset, gameState.ai.Config.priorities[this.queueToReset]);
};

KIARA.UpgradePlan.prototype.Serialize = function()
{
	return {
		"category": this.category,
		"type": this.type,
		"ID": this.ID,
		"metadata": this.metadata,
		"cost": this.cost.Serialize(),
		"number": this.number,
		"entId": this.entId,
		"upgrade": this.upgrade,
		"queueToReset": this.queueToReset || undefined
	};
};

KIARA.UpgradePlan.prototype.Deserialize = function(gameState, data)
{
	for (let key in data)
		this[key] = data[key];

	this.cost = new API3.Resources();
	this.cost.Deserialize(data.cost);
};
