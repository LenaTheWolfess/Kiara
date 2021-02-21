Engine.IncludeModule("common-api");

var KIARA = {};

KIARA.Logger = function(){};
KIARA.Logger.TRACE = 0;
KIARA.Logger.DEBUG = 1;
KIARA.Logger.WARN = 2;
KIARA.Logger.ERROR = 3;
KIARA.Logger.RELEASE = 4;
KIARA.Logger.level = KIARA.Logger.RELEASE;

KIARA.Strategy = function() {};
KIARA.Strategy.NONE = "none";
KIARA.Strategy.BOOM = "boom";
KIARA.Strategy.EARLY_RAID = "earlyRaid";
KIARA.Strategy.ATTACK = "attack";
KIARA.Strategy.RECOVER = "recover";
KIARA.Strategy.DEFAULT = KIARA.Strategy.NONE;

KIARA.AttackTypes = function() {};
KIARA.AttackTypes.ANIHILATION = "Anihilation";
KIARA.AttackTypes.RUSH = "Rush";
KIARA.AttackTypes.EARLY_RAID = "EarlyRaid";
KIARA.AttackTypes.RAID = "Raid";
KIARA.AttackTypes.ATTACK = "Attack";
KIARA.AttackTypes.HUGE_ATTACK = "HugeAttack";
KIARA.AttackTypes.MELLE_RANGE_INF_CAV = "MeleeRangeInfCav";
KIARA.AttackTypes.MELLE_RANGE_CAV = "MeleeRangeCav";
KIARA.AttackTypes.MELLE_CAV = "MeleeCav";
KIARA.AttackTypes.RANGE_CAV = "RangeCav";

// for instance "balanced", "aggressive" or "defensive"
KIARA.Behaviour = function() {};
KIARA.Behaviour.BALANCED = "balanced";
KIARA.Behaviour.AGGRESIVE = "aggressive";
KIARA.Behaviour.DEFENSIVE = "defensive";
KIARA.Behaviour.RANDOM = "random";
KIARA.Behaviour.DEFAULT = KIARA.Behaviour.RANDOM;

KIARA.Difficulty = function() {};
KIARA.Difficulty.SANDBOX = 0;
KIARA.Difficulty.VERY_EASY = 1;
KIARA.Difficulty.EASY = 2;
KIARA.Difficulty.MEDIUM = 3;
KIARA.Difficulty.HARD = 4;
KIARA.Difficulty.VERY_HARD = 5;
KIARA.Difficulty.DEFAULT = KIARA.Difficulty.MEDIUM;

KIARA.TemplateConstants = function() {};
KIARA.TemplateConstants.MorePopulation = "MorePopulation";
KIARA.TemplateConstants.Dropsite = "Dropsite";
KIARA.TemplateConstants.Farmstead = "Farmstead";
KIARA.TemplateConstants.Market = "Market";
KIARA.TemplateConstants.Field = "Field";
KIARA.TemplateConstants.Wonder = "Wonder";
KIARA.TemplateConstants.Corral = "Corral";
KIARA.TemplateConstants.CC = "CC";
KIARA.TemplateConstants.Colony = "Colony";
KIARA.TemplateConstants.Fortress = "Fortress";
KIARA.TemplateConstants.MeleeAndRanged = "MeleeAndRanged";
KIARA.TemplateConstants.Ranged = "Ranged";
KIARA.TemplateConstants.Cavalry = "Cavalry";
KIARA.TemplateConstants.Siege = "Siege";
KIARA.TemplateConstants.Elephants = "Elephants";

KIARA.Templates = function() {};
KIARA.Templates[KIARA.TemplateConstants.MorePopulation] = "structures/{civ}/house";
KIARA.Templates[KIARA.TemplateConstants.Dropsite] = "structures/{civ}/storehouse";
KIARA.Templates[KIARA.TemplateConstants.Farmstead] = "structures/{civ}/farmstead";
KIARA.Templates[KIARA.TemplateConstants.Market] = "structures/{civ}/market";
KIARA.Templates[KIARA.TemplateConstants.Field] = "structures/{civ}/field";
KIARA.Templates[KIARA.TemplateConstants.Wonder] = "structures/{civ}/wonder";
KIARA.Templates[KIARA.TemplateConstants.Corral] = "structures/{civ}/corral";
KIARA.Templates[KIARA.TemplateConstants.CC] = "structures/{civ}/civil_centre";
KIARA.Templates[KIARA.TemplateConstants.Colony] = "structures/{civ}/military_colony";
KIARA.Templates[KIARA.TemplateConstants.Fortress] = "structures/{civ}/fortress";
KIARA.Templates[KIARA.TemplateConstants.MeleeAndRanged] = "structures/{civ}/barracks";
KIARA.Templates[KIARA.TemplateConstants.Cavalry] = "structures/{civ}/stable";
KIARA.Templates[KIARA.TemplateConstants.Ranged] = "structures/{civ}/range";
KIARA.Templates[KIARA.TemplateConstants.Siege] = "structures/{civ}/arsenal";
KIARA.Templates[KIARA.TemplateConstants.Elephants] = "structures/{civ}/elephant_stables";

KIARA.Logger.warn = function(output)
{
	if (KIARA.Logger.isWarn())
		API3.warn(output);
};

KIARA.Logger.debug = function(output)
{
	if (KIARA.Logger.isDebug())
		API3.warn(output);
};

KIARA.Logger.trace = function(output)
{
	if (KIARA.Logger.isTrace())
		API3.warn(output);
};

KIARA.Logger.error = function(output)
{
	if (KIARA.Logger.isError())
		API3.error(output);
};

KIARA.Logger.isDebug = function()
{
	return KIARA.Logger.DEBUG >= KIARA.Logger.level;
};

KIARA.Logger.isWarn = function()
{
	return KIARA.Logger.WARN >= KIARA.Logger.level;
};

KIARA.Logger.isTrace = function()
{
	return KIARA.Logger.TRACE >= KIARA.Logger.level;
};

KIARA.Logger.isError = function()
{
	return KIARA.Logger.ERROR >= KIARA.Logger.level;
};


KIARA.Logger.isSerialization = function()
{
	return false;
};

KIARA.KiaraBot = function(settings)
{
	API3.BaseAI.call(this, settings);

	this.playedTurn = 0;
	this.elapsedTime = 0;

	this.uniqueIDs = {
		"armies": 1,	// starts at 1 to allow easier tests on armies ID existence
		"bases": 1,	// base manager ID starts at one because "0" means "no base" on the map
		"plans": 0,	// training/building/research plans
		"transports": 1	// transport plans start at 1 because 0 might be used as none
	};

	this.Config = new KIARA.Config(settings.difficulty, settings.behavior);

	this.savedEvents = {};
};

KIARA.KiaraBot.prototype = Object.create(API3.BaseAI.prototype);

KIARA.KiaraBot.prototype.CustomInit = function(gameState)
{
	if (this.isDeserialized)
	{
		// WARNING: the deserializations should not modify the metadatas infos inside their init functions
		this.turn = this.data.turn;
		this.playedTurn = this.data.playedTurn;
		this.elapsedTime = this.data.elapsedTime;
		this.savedEvents = this.data.savedEvents;
		for (let key in this.savedEvents)
		{
			for (let i in this.savedEvents[key])
			{
				if (!this.savedEvents[key][i].entityObj)
					continue;
				let evt = this.savedEvents[key][i];
				let evtmod = {};
				for (let keyevt in evt)
				{
					evtmod[keyevt] = evt[keyevt];
					evtmod.entityObj = new API3.Entity(gameState.sharedScript, evt.entityObj);
					this.savedEvents[key][i] = evtmod;
				}
			}
		}

		this.Config.Deserialize(this.data.config);

		this.queueManager = new KIARA.QueueManager(this.Config, {});
		this.queueManager.Deserialize(gameState, this.data.queueManager);
		this.queues = this.queueManager.queues;

		this.HQ = new KIARA.HQ(this.Config);
		this.HQ.init(gameState, this.queues);
		this.HQ.Deserialize(gameState, this.data.HQ);

		this.uniqueIDs = this.data.uniqueIDs;
		this.isDeserialized = false;
		this.data = undefined;

		// initialisation needed after the completion of the deserialization
		this.HQ.postinit(gameState);
	}
	else
	{
		this.Config.setConfig(gameState);

		// this.queues can only be modified by the queue manager or things will go awry.
		this.queues = {};
		for (let i in this.Config.priorities)
			this.queues[i] = new KIARA.Queue();

		this.queueManager = new KIARA.QueueManager(this.Config, this.queues);

		this.HQ = new KIARA.HQ(this.Config);

		this.HQ.init(gameState, this.queues);

		// Analyze our starting position and set a strategy
		this.HQ.gameAnalysis(gameState);
	}
};

KIARA.KiaraBot.prototype.OnUpdate = function(sharedScript)
{
	if (this.gameFinished)
		return;

	for (let i in this.events)
	{
		if (i == "AIMetadata")   // not used inside petra
			continue;
		if(this.savedEvents[i] !== undefined)
			this.savedEvents[i] = this.savedEvents[i].concat(this.events[i]);
		else
			this.savedEvents[i] = this.events[i];
	}

	// Run the update every n turns, offset depending on player ID to balance the load
	this.elapsedTime = this.gameState.getTimeElapsed() / 1000;
	if (!this.playedTurn || (this.turn + this.player) % 8 == 5)
	{
		Engine.ProfileStart("KiaraBot bot (player " + this.player +")");

		this.playedTurn++;

		if (this.gameState.getOwnEntities().length === 0)
		{
			Engine.ProfileStop();
			return; // With no entities to control the AI cannot do anything
		}

		this.HQ.update(this.gameState, this.queues, this.savedEvents);

		this.queueManager.update(this.gameState);

		for (let i in this.savedEvents)
			this.savedEvents[i] = [];

		Engine.ProfileStop();
	}

	this.turn++;
};

KIARA.KiaraBot.prototype.Serialize = function()
{
	let savedEvents = {};
	for (let key in this.savedEvents)
	{
		savedEvents[key] = this.savedEvents[key].slice();
		for (let i in savedEvents[key])
		{
			if (!savedEvents[key][i] || !savedEvents[key][i].entityObj)
				continue;
			let evt = savedEvents[key][i];
			let evtmod = {};
			for (let keyevt in evt)
				evtmod[keyevt] = evt[keyevt];
			evtmod.entityObj = evt.entityObj._entity;
			savedEvents[key][i] = evtmod;
		}
	}

	return {
		"uniqueIDs": this.uniqueIDs,
		"turn": this.turn,
		"playedTurn": this.playedTurn,
		"elapsedTime": this.elapsedTime,
		"savedEvents": savedEvents,
		"config": this.Config.Serialize(),
		"queueManager": this.queueManager.Serialize(),
		"HQ": this.HQ.Serialize()
	};
};

KIARA.KiaraBot.prototype.Deserialize = function(data, sharedScript)
{
	this.isDeserialized = true;
	this.data = data;
};
