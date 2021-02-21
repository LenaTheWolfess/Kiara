/**
 * Common functions and variables to all queue plans.
 */

KIARA.QueuePlan = function(gameState, type, metadata)
{
	this.type = gameState.applyCiv(type);
	this.metadata = metadata;
	this.started = false;

	this.template = gameState.getTemplate(this.type);
	if (!this.template)
	{
		KIARA.Logger.debug("Tried to add the inexisting template " + this.type + " to Kiara.");
		return false;
	}
	this.ID = gameState.ai.uniqueIDs.plans++;
	this.cost = new API3.Resources(this.template.cost());
	this.number = 1;
	this.category = "";

	return true;
};

/** Check the content of this queue */
KIARA.QueuePlan.prototype.isInvalid = function(gameState)
{
	return false;
};

/** if true, the queue manager will begin increasing this plan's account. */
KIARA.QueuePlan.prototype.isGo = function(gameState)
{
	return !this.started;
};

/** can we start this plan immediately? */
KIARA.QueuePlan.prototype.canStart = function(gameState)
{
	return false;
};

/** process the plan. */
KIARA.QueuePlan.prototype.start = function(gameState)
{
	if (this.started)
		return;
	this.onStart(gameState);
};

KIARA.QueuePlan.prototype.getCost = function()
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
KIARA.QueuePlan.prototype.onStart = function(gameState)
{
	this.started = true;
};

KIARA.QueuePlan.prototype.allreadyStarted = function()
{
	return this.started;
};