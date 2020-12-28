var KIARA = function(m)
{
/**
 * Common functions and variables to all queue plans.
 */

m.QueuePlan = function(gameState, type, metadata)
{
	this.type = gameState.applyCiv(type);
	this.metadata = metadata;
	this.started = false;

	this.template = gameState.getTemplate(this.type);
	if (!this.template)
	{
		API3.warn("Tried to add the inexisting template " + this.type + " to Kiara.");
		return false;
	}
	this.ID = gameState.ai.uniqueIDs.plans++;
	this.cost = new API3.Resources(this.template.cost());
	this.number = 1;
	this.category = "";

	return true;
};

/** Check the content of this queue */
m.QueuePlan.prototype.isInvalid = function(gameState)
{
	return false;
};

/** if true, the queue manager will begin increasing this plan's account. */
m.QueuePlan.prototype.isGo = function(gameState)
{
	return !this.started;
};

/** can we start this plan immediately? */
m.QueuePlan.prototype.canStart = function(gameState)
{
	return false;
};

/** process the plan. */
m.QueuePlan.prototype.start = function(gameState)
{
	if (this.started)
		return;
	this.onStart(gameState);
};

m.QueuePlan.prototype.getCost = function()
{
	let costs = new API3.Resources();
	costs.add(this.cost);
	if (this.number !== 1)
		costs.multiply(this.number);
	return costs;
};

/**
 * On Event functions.
 * Can be used to do some specific stuffs
 * Need to be updated to actually do something if you want them to.
 * this is called by "Start" if it succeeds.
 */
m.QueuePlan.prototype.onStart = function(gameState)
{
	this.started = true;
};

m.QueuePlan.prototype.allreadyStarted = function()
{
	return this.started;
}
return m;
}(KIARA);
