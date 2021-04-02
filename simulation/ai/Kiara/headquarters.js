/**
 * Headquarters
 * Deal with high level logic for the AI. Most of the interesting stuff gets done here.
 * Some tasks:
 *  -defining RESS needs
 *  -BO decisions.
 *     > training workers
 *     > building stuff (though we'll send that to bases)
 *  -picking strategy (specific manager?)
 *  -diplomacy -> diplomacyManager
 *  -planning attacks -> attackManager
 *  -picking new CC locations.
 */
KIARA.HQ = function(Config)
{
	this.Config = Config;
	this.phasing = 0;	// existing values: 0 means no, i > 0 means phasing towards phase i

	// Cache various quantities.
	this.turnCache = {};
	this.lastFailedGather = {};

	this.firstBaseConfig = false;
	this.currentBase = 0;	// Only one base (from baseManager) is run every turn.

	// Workers configuration.
	this.targetNumWorkers = this.Config.Economy.targetNumWorkers;
	this.supportRatio = this.Config.Economy.supportRatio;

	this.fortStartTime = 0;	// Sentry towers, will start at fortStartTime + towerLapseTime.
	this.towerStartTime = 0;	// Stone towers, will start as soon as available (town phase).
	this.towerLapseTime = this.Config.Military.towerLapseTime;
	this.fortressStartTime = 0;	// Fortresses, will start as soon as available (city phase).
	this.fortressLapseTime = this.Config.Military.fortressLapseTime;
	this.extraTowers = 5;
	if (this.Config.behaviour == KIARA.Behaviour.AGGRESIVE)
		this.extraTowers = 0;
	this.extraFortresses = 1;

	this.baseManagers = [];
	this.attackManager = new KIARA.AttackManager(this.Config);
	this.buildManager = new KIARA.BuildManager();
	this.defenseManager = new KIARA.DefenseManager(this.Config);
	this.tradeManager = new KIARA.TradeManager(this.Config);
	this.navalManager = new KIARA.NavalManager(this.Config);
	this.researchManager = new KIARA.ResearchManager(this.Config);
	this.diplomacyManager = new KIARA.DiplomacyManager(this.Config);
	this.garrisonManager = new KIARA.GarrisonManager(this.Config);
	this.victoryManager = new KIARA.VictoryManager(this.Config);

	this.capturableTargets = new Map();
	this.capturableTargetsTime = 0;


	this.phasingQued = false;

	this.wantPop  = false;
	this.rangedSwitcher = true;
	this.cavSwitcher = true;

	this.needDropsite = {};
	for (let res of Resources.GetCodes())
		this.needDropsite[res] = false;

	this.strategy = KIARA.Strategy.DEFAULT;

	let beh = this.Config.behaviour;
	if (beh == KIARA.Behaviour.BALANCED)
		this.strategy = KIARA.Strategy.BOOM;
	if (beh == KIARA.Behaviour.DEFENSIVE)
		this.strategy = KIARA.Strategy.NONE;
	if (beh == KIARA.Behaviour.AGGRESIVE)
		this.strategy = KIARA.Strategy.BOOM;
};

/** More initialisation for stuff that needs the gameState */
KIARA.HQ.prototype.init = function(gameState, queues)
{
	this.territoryMap = KIARA.createTerritoryMap(gameState);
	// initialize base map. Each pixel is a base ID, or 0 if not or not accessible
	this.basesMap = new API3.Map(gameState.sharedScript, "territory");
	// create borderMap: flag cells on the border of the map
	// then this map will be completed with our frontier in updateTerritories
	this.borderMap = KIARA.createBorderMap(gameState);
	// list of allowed regions
	this.landRegions = {};
	// try to determine if we have a water map
	this.navalMap = false;
	this.navalRegions = {};

	this.treasures = gameState.getEntities().filter(ent => {
		let type = ent.resourceSupplyType();
		return type && type.generic == "treasure";
	});
	this.treasures.registerUpdates();
	this.currentPhase = gameState.currentPhase();
	this.decayingStructures = new Set();
};

/**
 * initialization needed after deserialization (only called when deserialization)
 */
KIARA.HQ.prototype.postinit = function(gameState)
{
	// Rebuild the base maps from the territory indices of each base
	this.basesMap = new API3.Map(gameState.sharedScript, "territory");
	for (let base of this.baseManagers)
		for (let j of base.territoryIndices)
			this.basesMap.map[j] = base.ID;

	for (let ent of gameState.getOwnEntities().values())
	{
		if (!ent.resourceDropsiteTypes() || !ent.hasClass("Structure"))
			continue;
		// Entities which have been built or have changed ownership after the last AI turn have no base.
		// they will be dealt with in the next checkEvents
		let baseID = ent.getMetadata(PlayerID, "base");
		if (baseID === undefined)
			continue;
		let base = this.getBaseByID(baseID);
		base.assignResourceToDropsite(gameState, ent);
	}

	this.updateTerritories(gameState);
};

/**
 * Create a new base in the baseManager:
 * If an existing one without anchor already exist, use it.
 * Otherwise create a new one.
 * TODO when buildings, criteria should depend on distance
 * allowedType: undefined       => new base with an anchor
 *              "unconstructed" => new base with a foundation anchor
 *              "captured"      => captured base with an anchor
 *              "anchorless"    => anchorless base, currently with dock
 */
KIARA.HQ.prototype.createBase = function(gameState, ent, type)
{
	let access = KIARA.getLandAccess(gameState, ent);
	let newbase;
	for (let base of this.baseManagers)
	{
		if (base.accessIndex != access)
			continue;
		if (type != "anchorless" && base.anchor)
			continue;
		if (type != "anchorless")
		{
			// TODO we keep the fisrt one, we should rather use the nearest if buildings
			// and possibly also cut on distance
			newbase = base;
			break;
		}
		else
		{
			// TODO here also test on distance instead of first
			if (newbase && !base.anchor)
				continue;
			newbase = base;
			if (newbase.anchor)
				break;
		}
	}

	if (KIARA.Logger.isDebug())
	{
		KIARA.Logger.debug(" ----------------------------------------------------------");
		KIARA.Logger.debug(" HQ createBase entrance avec access " + access + " and type " + type);
		KIARA.Logger.debug(" with access " + uneval(this.baseManagers.map(base => base.accessIndex)) +
			  " and base nbr " + uneval(this.baseManagers.map(base => base.ID)) +
			  " and anchor " + uneval(this.baseManagers.map(base => !!base.anchor)));
	}

	if (!newbase)
	{
		newbase = new KIARA.BaseManager(gameState, this.Config);
		newbase.init(gameState, type);
		this.baseManagers.push(newbase);
	}
	else
		newbase.reset(type);

	if (type != "anchorless")
		newbase.setAnchor(gameState, ent);
	else
		newbase.setAnchorlessEntity(gameState, ent);

	return newbase;
};

/**
 * returns the sea index linking regions 1 and region 2 (supposed to be different land region)
 * otherwise return undefined
 * for the moment, only the case land-sea-land is supported
 */
KIARA.HQ.prototype.getSeaBetweenIndices = function(gameState, index1, index2)
{
	let path = gameState.ai.accessibility.getTrajectToIndex(index1, index2);
	if (path && path.length == 3 && gameState.ai.accessibility.regionType[path[1]] == "water")
		return path[1];

	KIARA.Logger.error("bad path from " + index1 + " to " + index2 + " ??? " + uneval(path));
	KIARA.Logger.error(" regionLinks start " + uneval(gameState.ai.accessibility.regionLinks[index1]));
	KIARA.Logger.error(" regionLinks end   " + uneval(gameState.ai.accessibility.regionLinks[index2]));

	return undefined;
};

/** TODO check if the new anchorless bases should be added to addBase */
KIARA.HQ.prototype.checkEvents = function(gameState, events)
{
	let addBase = false;

	this.buildManager.checkEvents(gameState, events);

	if (events.TerritoriesChanged.length || events.DiplomacyChanged.length)
		this.updateTerritories(gameState);

	for (let evt of events.DiplomacyChanged)
	{
		if (evt.player != PlayerID && evt.otherPlayer != PlayerID)
			continue;
		// Reset the entities collections which depend on diplomacy
		gameState.resetOnDiplomacyChanged();
		break;
	}

	for (let evt of events.Destroy)
	{
		// Let's check we haven't lost an important building here.
		if (evt && !evt.SuccessfulFoundation && evt.entityObj && evt.metadata && evt.metadata[PlayerID] &&
			evt.metadata[PlayerID].base)
		{
			let ent = evt.entityObj;
			if (ent.owner() != PlayerID)
				continue;
			// A new base foundation was created and destroyed on the same (AI) turn
			this.expanding = false;
			if (evt.metadata[PlayerID].base == -1 || evt.metadata[PlayerID].base == -2)
				continue;
			let base = this.getBaseByID(evt.metadata[PlayerID].base);
			if (ent.resourceDropsiteTypes() && ent.hasClass("Structure"))
				base.removeDropsite(gameState, ent);
			if (evt.metadata[PlayerID].baseAnchor && evt.metadata[PlayerID].baseAnchor === true)
				base.anchorLost(gameState, ent);
		}
	}

	for (let evt of events.EntityRenamed)
	{
		let ent = gameState.getEntityById(evt.newentity);
		if (!ent || ent.owner() != PlayerID || ent.getMetadata(PlayerID, "base") === undefined)
			continue;
		let base = this.getBaseByID(ent.getMetadata(PlayerID, "base"));
		if (!base.anchorId || base.anchorId != evt.entity)
			continue;
		base.anchorId = evt.newentity;
		base.anchor = ent;
	}

	for (let evt of events.Create)
	{
		// Let's check if we have a valuable foundation needing builders quickly
		// (normal foundations are taken care in baseManager.assignToFoundations)
		let ent = gameState.getEntityById(evt.entity);
		if (!ent || ent.owner() != PlayerID || ent.foundationProgress() === undefined)
			continue;

		if (ent.getMetadata(PlayerID, "base") == -1)	// Standard base around a cc
		{
			// Okay so let's try to create a new base around this.
			let newbase = this.createBase(gameState, ent, "unconstructed");
			// Let's get a few units from other bases there to build this.
			let builders = this.bulkPickWorkers(gameState, newbase, 10);
			if (builders !== false)
			{
				builders.forEach(worker => {
					worker.setMetadata(PlayerID, "base", newbase.ID);
					worker.setMetadata(PlayerID, "subrole", "builder");
					worker.setMetadata(PlayerID, "target-foundation", ent.id());
				});
			}
		}
		else if (ent.getMetadata(PlayerID, "base") == -2)	// anchorless base around a dock
		{
			let newbase = this.createBase(gameState, ent, "anchorless");
			// Let's get a few units from other bases there to build this.
			let builders = this.bulkPickWorkers(gameState, newbase, 4);
			if (builders != false)
			{
				builders.forEach(worker => {
					worker.setMetadata(PlayerID, "base", newbase.ID);
					worker.setMetadata(PlayerID, "subrole", "builder");
					worker.setMetadata(PlayerID, "target-foundation", ent.id());
				});
			}
		}
	}

	for (let evt of events.ConstructionFinished)
	{
		if (evt.newentity == evt.entity)  // repaired building
			continue;
		let ent = gameState.getEntityById(evt.newentity);
		if (!ent || ent.owner() != PlayerID)
			continue;
		if (ent.hasClass("Market") && this.maxFields)
			this.maxFields = false;
		if (this.expanding && ent.hasClass("CivCentre"))
			this.expanding = false;
		if (ent.getMetadata(PlayerID, "base") === undefined)
			continue;
			let res = ent.getMetadata(PlayerID, "type");
		let coloring = false;
		if (res & coloring) {
			KIARA.Logger.trace("Dropsite build for " + res);
			if (res == "wood")
				Engine.PostCommand(PlayerID,{"type": "set-shading-color", "entities": [ent.id()], "rgb": [2,0,0]});
			if (res == "stone")
				Engine.PostCommand(PlayerID,{"type": "set-shading-color", "entities": [ent.id()], "rgb": [0,2,0]});
			if (res == "metal")
				Engine.PostCommand(PlayerID,{"type": "set-shading-color", "entities": [ent.id()], "rgb": [0,0,2]});
		}
		let base = this.getBaseByID(ent.getMetadata(PlayerID, "base"));
		base.buildings.updateEnt(ent);
		if (ent.resourceDropsiteTypes())
			base.assignResourceToDropsite(gameState, ent);
		if (ent.hasClass("Field"))
			this.signalNoNeedSupply("food");

		if (ent.getMetadata(PlayerID, "baseAnchor") === true)
		{
			if (base.constructing)
				base.constructing = false;
			addBase = true;
		}
	}

	for (let evt of events.OwnershipChanged)   // capture events
	{
		if (evt.from == PlayerID)
		{
			let ent = gameState.getEntityById(evt.entity);
			if (!ent || ent.getMetadata(PlayerID, "base") === undefined)
				continue;
			let base = this.getBaseByID(ent.getMetadata(PlayerID, "base"));
			if (ent.resourceDropsiteTypes() && ent.hasClass("Structure"))
				base.removeDropsite(gameState, ent);
			if (ent.getMetadata(PlayerID, "baseAnchor") === true)
				base.anchorLost(gameState, ent);
		}

		if (evt.to != PlayerID)
			continue;
		let ent = gameState.getEntityById(evt.entity);
		if (!ent)
			continue;
		if (ent.hasClass("Unit"))
		{
			KIARA.getBestBase(gameState, ent).assignEntity(gameState, ent);
			ent.setMetadata(PlayerID, "role", undefined);
			ent.setMetadata(PlayerID, "subrole", undefined);
			ent.setMetadata(PlayerID, "plan", undefined);
			ent.setMetadata(PlayerID, "PartOfArmy", undefined);
			if (ent.hasClass("Trader"))
			{
				ent.setMetadata(PlayerID, "role", "trader");
				ent.setMetadata(PlayerID, "route", undefined);
			}
			if (ent.hasClass("Worker"))
			{
				ent.setMetadata(PlayerID, "role", "worker");
				ent.setMetadata(PlayerID, "subrole", "idle");
			}
			if (ent.hasClass("Ship"))
				KIARA.setSeaAccess(gameState, ent);
			if (!ent.hasClass("Support") && !ent.hasClass("Ship") && ent.attackTypes() !== undefined)
				ent.setMetadata(PlayerID, "plan", -1);
			continue;
		}
		if (ent.hasClass("CivCentre"))   // build a new base around it
		{
			let newbase;
			if (ent.foundationProgress() !== undefined)
				newbase = this.createBase(gameState, ent, "unconstructed");
			else
			{
				newbase = this.createBase(gameState, ent, "captured");
				addBase = true;
			}
			newbase.assignEntity(gameState, ent);
		}
		else
		{
			let base;
			// If dropsite on new island, create a base around it
			if (!ent.decaying() && ent.resourceDropsiteTypes())
				base = this.createBase(gameState, ent, "anchorless");
			else
				base = KIARA.getBestBase(gameState, ent) || this.baseManagers[0];
			base.assignEntity(gameState, ent);
			if (ent.decaying())
			{
				if (ent.isGarrisonHolder() && this.garrisonManager.addDecayingStructure(gameState, evt.entity, true))
					continue;
				if (!this.decayingStructures.has(evt.entity))
					this.decayingStructures.add(evt.entity);
			}
		}
	}

	// deal with the different rally points of training units: the rally point is set when the training starts
	// for the time being, only autogarrison is used

	for (let evt of events.TrainingStarted)
	{
		let ent = gameState.getEntityById(evt.entity);
		if (!ent || !ent.isOwn(PlayerID))
			continue;

		if (!ent._entity.trainingQueue || !ent._entity.trainingQueue.length)
			continue;
		let metadata = ent._entity.trainingQueue[0].metadata;
		if (metadata && metadata.garrisonType)
			ent.setRallyPoint(ent, "garrison");  // trained units will autogarrison
		else
			ent.unsetRallyPoint();
	}

	for (let evt of events.TrainingFinished)
	{
		for (let entId of evt.entities)
		{
			let ent = gameState.getEntityById(entId);
			if (!ent || !ent.isOwn(PlayerID))
				continue;

			if (!ent.position())
			{
				// we are autogarrisoned, check that the holder is registered in the garrisonManager
				let holderId = ent.unitAIOrderData()[0].target;
				let holder = gameState.getEntityById(holderId);
				if (holder)
					this.garrisonManager.registerHolder(gameState, holder);
			}
			else if (ent.getMetadata(PlayerID, "garrisonType"))
			{
				// we were supposed to be autogarrisoned, but this has failed (may-be full)
				ent.setMetadata(PlayerID, "garrisonType", undefined);
			}

			let stance = "defensive";
			let st = ent.getStance();
			if (st != stance && st != "passive")
				ent.setStance(stance);
			// Check if this unit is no more needed in its attack plan
			// (happen when the training ends after the attack is started or aborted)
			let plan = ent.getMetadata(PlayerID, "plan");
			if (plan !== undefined && plan >= 0)
			{
				let attack = this.attackManager.getPlan(plan);
				if (!attack || attack.state != "unexecuted")
					ent.setMetadata(PlayerID, "plan", -1);
			}
			// Assign it immediately to something useful to do
			if (ent.getMetadata(PlayerID, "role") == "worker")
			{
				let base;
				if (ent.getMetadata(PlayerID, "base") === undefined)
				{
					base = KIARA.getBestBase(gameState, ent);
					base.assignEntity(gameState, ent);
				}
				else
					base = this.getBaseByID(ent.getMetadata(PlayerID, "base"));
				base.reassignIdleWorkers(gameState, [ent]);
				base.workerObject.update(gameState, ent);
			}
			else if (ent.resourceSupplyType() && ent.position())
			{
				let type = ent.resourceSupplyType();
				if (!type.generic)
					continue;
				let dropsites = gameState.getOwnDropsites(type.generic);
				let pos = ent.position();
				let access = KIARA.getLandAccess(gameState, ent);
				let distmin = Math.min();
				let goal;
				for (let dropsite of dropsites.values())
				{
					if (!dropsite.position() || KIARA.getLandAccess(gameState, dropsite) != access)
						continue;
					let dist = API3.SquareVectorDistance(pos, dropsite.position());
					if (dist > distmin)
						continue;
					distmin = dist;
					goal = dropsite.position();
				}
				if (goal)
					ent.moveToRange(goal[0], goal[1]);
			}
		}
	}

	for (let evt of events.TerritoryDecayChanged)
	{
		let ent = gameState.getEntityById(evt.entity);
		if (!ent || !ent.isOwn(PlayerID) || ent.foundationProgress() !== undefined)
			continue;
		if (evt.to)
		{
			if (ent.isGarrisonHolder() && this.garrisonManager.addDecayingStructure(gameState, evt.entity))
				continue;
			if (!this.decayingStructures.has(evt.entity))
				this.decayingStructures.add(evt.entity);
		}
		else if (ent.isGarrisonHolder())
			this.garrisonManager.removeDecayingStructure(evt.entity);
	}

	for (let evt of events.ResearchFinished)
	{
		if (evt.player != PlayerID)
			continue;
		if (this.phasingQued) {
			let currentPhaseIndex = gameState.currentPhase(gameState);
			let phaseName = gameState.getPhaseName(currentPhaseIndex);
			if (evt.tech == phaseName)
				this.phasingQued = false;
		}
	}

	if (addBase)
	{
		if (!this.firstBaseConfig)
		{
			// This is our first base, let us configure our starting resources
			this.configFirstBase(gameState);
		}
		else
		{
			// Let us hope this new base will fix our possible resource shortage
			this.saveResources = undefined;
			this.saveSpace = undefined;
			this.maxFields = false;
		}
	}

	// Then deals with decaying structures: destroy them if being lost to enemy (except in easier difficulties)

	for (let entId of this.decayingStructures)
	{
		let ent = gameState.getEntityById(entId);
		if (ent && ent.decaying() && ent.isOwn(PlayerID))
		{
			let capture = ent.capturePoints();
			if (!capture)
				continue;
			let captureRatio = capture[PlayerID] / capture.reduce((a, b) => a + b);
			if (captureRatio < 0.50)
				continue;
			let decayToGaia = true;
			for (let i = 1; i < capture.length; ++i)
			{
				if (gameState.isPlayerAlly(i) || !capture[i])
					continue;
				decayToGaia = false;
				break;
			}
			if (decayToGaia)
				continue;
			let ratioMax = 0.7 + randFloat(0, 0.1);
			for (let evt of events.Attacked)
			{
				if (ent.id() != evt.target)
					continue;
				ratioMax = 0.85 + randFloat(0, 0.1);
				break;
			}
			if (captureRatio > ratioMax)
				continue;
			ent.destroy();
		}
		this.decayingStructures.delete(entId);
	}
};

/** Ensure that all requirements are met when phasing up*/
KIARA.HQ.prototype.checkPhaseRequirements = function(gameState, queues)
{
	if (gameState.getNumberOfPhases() == this.currentPhase)
		return;

	let requirements = gameState.getPhaseEntityRequirements(this.currentPhase + 1);
	let plan;
	let queue;
	for (let entityReq of requirements)
	{
		// Village requirements are met elsewhere by constructing more houses
		if (entityReq.class == "Village" || entityReq.class == "NotField")
			continue;
		if (gameState.getOwnEntitiesByClass(entityReq.class, true).length >= entityReq.count)
			continue;
		switch (entityReq.class)
		{
		case "Town":
			if (!queues.economicBuilding.hasQueuedUnits() &&
			    !queues.militaryBuilding.hasQueuedUnits() &&
			    !queues.defenseBuilding.hasQueuedUnits())
			{
				if (!gameState.getOwnEntitiesByClass("Market", true).hasEntities() &&
				    this.canBuild(gameState, KIARA.Templates[KIARA.TemplateConstants.Market]))
				{
					plan = new KIARA.ConstructionPlan(gameState, KIARA.Templates[KIARA.TemplateConstants.Market], { "phaseUp": true });
					queue = "economicBuilding";
					break;
				}
				if (!gameState.getOwnEntitiesByClass("Temple", true).hasEntities() &&
				    this.canBuild(gameState, "structures/{civ}/temple"))
				{
					plan = new KIARA.ConstructionPlan(gameState, "structures/{civ}/temple", { "phaseUp": true });
					queue = "economicBuilding";
					break;
				}
				if (!gameState.getOwnEntitiesByClass("Forge", true).hasEntities() &&
				    this.canBuild(gameState, "structures/{civ}/forge"))
				{
					plan = new KIARA.ConstructionPlan(gameState, "structures/{civ}/forge", { "phaseUp": true });
					queue = "militaryBuilding";
					break;
				}
				if (this.canBuild(gameState, "structures/{civ}/defense_tower"))
				{
					plan = new KIARA.ConstructionPlan(gameState, "structures/{civ}/defense_tower", { "phaseUp": true });
					queue = "defenseBuilding";
					break;
				}
			}
			break;
		default:
			// All classes not dealt with inside vanilla game.
			// We put them for the time being on the economic queue, except if wonder
			queue = entityReq.class == "Wonder" ? "wonder" : "economicBuilding";
			if (!queues[queue].hasQueuedUnits())
			{
				let structure = this.buildManager.findStructureWithClass(gameState, [entityReq.class]);
				if (structure && this.canBuild(gameState, structure))
					plan = new KIARA.ConstructionPlan(gameState, structure, { "phaseUp": true });
			}
		}

		if (plan)
		{
			if (queue == "wonder")
			{
				gameState.ai.queueManager.changePriority("majorTech", 400, { "phaseUp": true });
				plan.queueToReset = "majorTech";
			}
			else
			{
				gameState.ai.queueManager.changePriority(queue, 1000, { "phaseUp": true });
				plan.queueToReset = queue;
			}
			queues[queue].addPlan(plan);
			return;
		}
	}
};

/** Called by any "phase" research plan once it's started */
KIARA.HQ.prototype.OnPhaseUp = function(gameState, phase)
{
};

KIARA.HQ.prototype.alwaysTrain = function(gameState, queues)
{
	if (gameState.getPopulationMax() <= gameState.getPopulationLimit())
		return;

	if (gameState.getPopulation() > gameState.getPopulationMax() * 0.8)
		return;

	if (gameState.getPopulationMax() <= gameState.getPopulationLimit())
		return;
	let fHouse = gameState.getOwnFoundationsByClass("House").length;
	let nHouses = queues.house.length();
	let hTemplate = KIARA.Templates[KIARA.TemplateConstants.MorePopulationAdv];
	if (!this.canBuild(gameState, hTemplate))
		hTemplate = KIARA.Templates[KIARA.TemplateConstants.MorePopulation];

	if (this.wantPop && gameState.getPopulationLimit() < this.wantPop) {
		if (!fHouse && !nHouses) {
			KIARA.Logger.debug("add house");
			let plan = new KIARA.ConstructionPlan(gameState, hTemplate);
			// change the starting condition according to the situation.
			plan.goRequirement = "houseNeeded";
			queues.house.addPlan(plan);
		}
		KIARA.Logger.debug("need house " + gameState.getPopulationLimit() + " < " + this.wantPop + " houses queued " + nHouses);
		return;
	}

	let civ = gameState.getPlayerCiv();
	let tHouse = gameState.getTemplate(gameState.applyCiv(hTemplate));
	let pHouse = tHouse.getPopulationBonus();

	let numberInTraining = 0;
	gameState.getOwnTrainingFacilities().forEach(function(ent) {
		for (let item of ent.trainingQueue())
			numberInTraining += item.count;
	});

	let numberQueued = 0;
	gameState.getOwnTrainingFacilities().forEach(function(ent) {
		let n = "ent_" + ent.id();
		let q = gameState.ai.queues[n];
		if (q)
			numberQueued += q.countQueuedUnits();
	});

	let pop = gameState.getPopulation() + numberQueued;
//	KIARA.Logger.debug("pop = " + gameState.getPopulation() + " queued pop = " + numberQueued);
	let free = gameState.getPopulationLimit() - (gameState.getPopulation() + numberInTraining);

	let anyClasses = ["Worker"];
	let anyRequirements = [ ["costsResource", 1, "food"], ["canGather", 1] ];

	let classesInf = ["Infantry"];
	let requirementsInf = [["strength", 2]];

	let classesMeleeInf = ["Melee", "CitizenSoldier", "Infantry"];
	let classesRangedInf = ["Ranged", "CitizenSoldier", "Infantry"];

	let farmers = gameState.getOwnEntitiesByClass("FemaleCitizen", true).length;
	let sieges = gameState.getOwnEntitiesByClass("Siege", true).length;
	let workers = gameState.getOwnEntitiesByClass("Worker", true).length;
	let cavs = gameState.getOwnEntitiesByClass("FastMoving", true).length;

//	KIARA.Logger.debug("farmers = " + farmers + ", workers = " + workers + ", sieges = " + sieges);
	let supportNum = 40;
	let siegeNum = 5;

	let wantDefenders = farmers + 1 > supportNum;

	let min = 1;
	let size = 10;
	let mSize = 10;

	if (workers > 5)
		size = 2;
	if (workers > 10)
		size = 5;
	if (workers > 40)
		size = pHouse;

	let classes = anyClasses;
	let requirements = anyRequirements;

	if (wantDefenders)
	{
		classes = classesInf;
		requirements = requirementsInf;
		if (pop > 50)
		{
			if (!this.rangedSwitcher)
				classes = classesRangedInf;
			else
				classes = classesMeleeInf;
		} else {
			min = 2;
		}
	}

	let wantCav = workers > 20 && this.strategy != KIARA.Strategy.EARLY_RAID && cavs < this.huntCav;
	let cavClasses = ["FastMoving"];
	let cavRequirements = [ ["canGather", 1] ];

	let wantSiege = workers > 150 && gameState.currentPhase(gameState) > 2 && sieges < siegeNum;
	let siegeClass = ["Siege"];
	let siegeRequirements = [["strength", 3]];

	let wantChampions = gameState.currentPhase(gameState) > 2 && workers > 150;
//	wantChampions = false;
	let championClass = ["Champion"];
	let championRequirements = [["strength", 2]];

	let ww = "worker";
	let fac = gameState.getOwnTrainingFacilities().values();
	let ssize = size;
	for (let ent of fac) {
		if (this.wantPop && gameState.getPopulationLimit() < this.wantPop) {
			KIARA.Logger.debug(gameState.getPopulationLimit() + " < " + this.wantPop);
			return;
		}
		let tt = ent.trainableEntities(civ);
		if (!tt)
			continue;
		let t = gameState.filterTrainableUnits(tt);
		if (!t)
			continue;
		let n = "ent_" + ent.id();
		let q = gameState.ai.queues[n];
		if (!q) {
			gameState.ai.queueManager.addQueue(n, 300);
			q = gameState.ai.queues[n];
		}
		if (ent.trainingQueue().length == 0 && q.length() < 1)
		{
			let mmin = min;
			let wwx = ww;
			let template;
			size = ssize;

			if (wantSiege)
			{
				template = this.findBestTrainableUnitSpecial(gameState, siegeClass, siegeRequirements, t);
				if (template)
				{
					//wwx = "attack";
					wwx = undefined;
					size = 2;
					mmin = 2;
				}
			}
			if (!template && wantCav && this.cavSwitcher) {
				template = this.findBestTrainableUnitSpecial(gameState, cavClasses, cavRequirements, t);
				if (template) {
					size = 2;
					mmin = 1;
				}
			}
			if (!template && wantChampions) {
				template = this.findBestTrainableUnitSpecial(gameState, championClass, championRequirements, t);
				if (template) {
					wwx = undefined;
				}
			}
			if (!template)
				template = this.findBestTrainableUnitSpecial(gameState, classes, requirements, t);
			if (!template && wantDefenders && this.rangedSwitcher)
				template = this.findBestTrainableUnitSpecial(gameState, classesRangedInf, requirements, t);
			if (!template && wantDefenders && !this.rangedSwitcher)
				template = this.findBestTrainableUnitSpecial(gameState, classesMeleeInf, requirements, t);

			if (!template)
				template = this.findBestTrainableUnitSpecial(gameState, anyClasses, anyRequirements, t);

			if (!template)
				continue;

			mSize = size;

			let actualTemplate = gameState.getTemplate(template);
			let cost = new API3.Resources(actualTemplate.cost());
			let res = gameState.getResources();

			for (let r of Resources.GetCodes()) {
				if (!res[r])
					continue;
				size = Math.min(size, Math.floor(res[r]/cost[r]));
			}
			size = Math.max(size, mmin);
			if (!size)
				continue;
			mSize = Math.min(size, 5);

			let missing = pop - (gameState.getPopulationLimit() + (fHouse * pHouse));
			let possible = gameState.getPopulationLimit() - (pop - size);

			pop += size;
			if (missing > 0) {
				KIARA.Logger.debug("missing " + missing + " -> " + pop);
				this.wantPop = pop;
				while (nHouses < 3 && missing > 0) {
					warn("add house");
					let plan = new KIARA.ConstructionPlan(gameState, hTemplate);
					// change the starting condition according to the situation.
					plan.goRequirement = "houseNeeded";
					queues.house.addPlan(plan);
					missing = missing - pHouse;
					nHouses++;
				}
				if (possible > 0)
				{
					possible = Math.min(size, possible);
					KIARA.Logger.debug("possible " + possible);
					size = possible;
					mSize = size;
				}
				else
					return;
			}

			let role = {"base": 0, "role": wwx, "support": actualTemplate.hasClass("Support")};
			KIARA.Logger.debug("addPlan " + template + " " + size);
			q.addPlan(new KIARA.TrainingPlan(gameState, template, role, size, mSize));
			if (wantDefenders)
			{
				this.rangedSwitcher = !this.rangedSwitcher;
				if (!this.rangedSwitcher)
					classes = classesRangedInf;
				else
					classes = classesMeleeInf;
			}
			if (wantCav)
				this.cavSwitcher = !this.cavSwitcher;
			if (missing > 0)
				return;
		}
	}
}

KIARA.HQ.prototype.trainMoreWorkersOld = function(gameState, queues)
{
	if (gameState.getPopulationMax() <= gameState.getPopulationLimit())
		return;
	let fHouse = gameState.getOwnFoundationsByClass("House").length;

	if (this.wantPop && gameState.getPopulationLimit() < this.wantPop) {
		if (!fHouse && !queues.house.length()) {
			let plan = new KIARA.ConstructionPlan(gameState, KIARA.Templates[KIARA.TemplateConstants.MorePopulation]);
			// change the starting condition according to the situation.
			plan.goRequirement = "houseNeeded";
			queues.house.addPlan(plan);
		}
		KIARA.Logger.debug("need house");
		return;
	}
	// counting the workers that aren't part of a plan
	let numberOfWorkers = 0;   // all workers
	let numberOfSupports = 0;  // only support workers (i.e. non fighting)
	let numberOfHunters = 0;
	let numberOfMelee = 0;
	let numberOfRanged = 0;
	let numberOfInfantry = 0;

	gameState.getOwnUnits().forEach(ent => {
		if (ent.getMetadata(PlayerID, "role") == "worker" && ent.getMetadata(PlayerID, "plan") === undefined)
		{
			++numberOfWorkers;
			if (ent.hasClass("Support"))
				++numberOfSupports;
			if (ent.hasClass("FastMoving"))
				++numberOfHunters;
			if (ent.hasClass("CitizenSoldier") && ent.hasClass("Infantry")) {
				++numberOfInfantry;
				if (ent.hasClass("Melee"))
					++numberOfMelee;
				if (ent.hasClass("Ranged"))
					++numberOfRanged;
			}
		}
	});
	let numberInTraining = 0;
	gameState.getOwnTrainingFacilities().forEach(function(ent) {
		for (let item of ent.trainingQueue())
		{
			numberInTraining += item.count;
			if (item.metadata && item.metadata.role && item.metadata.role == "worker" &&
			    item.metadata.plan === undefined)
			{
				numberOfWorkers += item.count;
				if (item.metadata.support)
					numberOfSupports += item.count;
			}
		}
	});

	// Anticipate the optimal batch size when this queue will start
	// and adapt the batch size of the first and second queued workers to the present population
	// to ease a possible recovery if our population was drastically reduced by an attack
	// (need to go up to second queued as it is accounted in queueManager)
	let size = 10;
	let min = 1;
	if (queues.villager.plans[0])
	{
		queues.villager.plans[0].number = Math.min(queues.villager.plans[0].number, size);
		if (queues.villager.plans[1])
			queues.villager.plans[1].number = Math.min(queues.villager.plans[1].number, size);
	}
	if (queues.citizenSoldier.plans[0])
	{
		queues.citizenSoldier.plans[0].number = Math.min(queues.citizenSoldier.plans[0].number, size);
		if (queues.citizenSoldier.plans[1])
			queues.citizenSoldier.plans[1].number = Math.min(queues.citizenSoldier.plans[1].number, size);
	}

	let numberOfQueuedSupports = queues.villager.countQueuedUnits();
	let numberOfQueuedSoldiers = queues.citizenSoldier.countQueuedUnits();
	let numberQueued = numberOfQueuedSupports + numberOfQueuedSoldiers;
	let numberTotal = numberOfWorkers + numberQueued;

	let pop = gameState.getPopulation() + numberQueued;
	let free = gameState.getPopulationLimit() - (gameState.getPopulation() + numberInTraining);

	let nHouses = queues.house.length();
	let tHouse = gameState.getTemplate(gameState.applyCiv(KIARA.Templates[KIARA.TemplateConstants.MorePopulation]));
	let pHouse = tHouse.getPopulationBonus();

	if (pop > 5)
		min = 2;
	if (pop > 20)
		min = pHouse;
	if (numberTotal > 50)
		min = pHouse * 2;
//	let mSize = Math.max(size, Math.min(free, 10));

//	KIARA.Logger.debug(pop + " -> " + size);

	if (numberOfSupports + numberOfQueuedSupports < 20) {
		if (this.saveResources && numberTotal > this.Config.Economy.popPhase2 + 10)
			return;
		if (numberTotal > this.targetNumWorkers || (numberTotal >= this.Config.Economy.popPhase2 &&
			this.currentPhase == 1 && !gameState.isResearching(gameState.getPhaseName(2))))
			return;
		if (numberQueued > 50 || (numberOfQueuedSupports > 20 && numberOfQueuedSoldiers > 20) || numberInTraining > 15)
			return;
	}

	if (numberOfQueuedSoldiers > 20 && numberOfQueuedSupports > 20)
		return;

	// Choose whether we want soldiers or support units: when full pop, we aim at targetNumWorkers workers
	// with supportRatio fraction of support units. But we want to have more support (less cost) at startup.
	// So we take: supportRatio*targetNumWorkers*(1 - exp(-alfa*currentWorkers/supportRatio/targetNumWorkers))
	// This gives back supportRatio*targetNumWorkers when currentWorkers >> supportRatio*targetNumWorkers
	// and gives a ratio alfa at startup.

	let supportRatio = this.supportRatio;
	let alpha = 0.85;
	if (!gameState.isTemplateAvailable(gameState.applyCiv(KIARA.Templates[KIARA.TemplateConstants.Field])))
		supportRatio = Math.min(this.supportRatio, 0.1);
	if (this.attackManager.rushNumber < this.attackManager.maxRushes || this.attackManager.upcomingAttacks.Rush.length)
		alpha = 0.7;
	if (gameState.isCeasefireActive())
		alpha += (1 - alpha) * Math.min(Math.max(gameState.ceasefireTimeRemaining - 120, 0), 180) / 180;
	let supportMax = supportRatio * this.targetNumWorkers;
	let supportNum = supportMax * (1 - Math.exp(-alpha*numberTotal/supportMax));

	let requirementsDef = [ ["costsResource", 1, "food"], ["canGather", 1] ];
	let classesDef = ["Worker"];
	let templateDef = this.findBestTrainableUnit(gameState, classesDef, requirementsDef);

	let actualTemplate = gameState.getTemplate(templateDef);
	let cost = new API3.Resources(actualTemplate.cost());
	let res = gameState.getResources();

	for (let r of Resources.GetCodes()) {
		if (!res[r])
			continue;
		size = Math.min(size, Math.floor(res[r]/cost[r]));
	}
	size = Math.max(size, min);
	if (!size)
		return;
	let mSize = Math.max(size, 5);

	let snCut = 40;

	let template;
	if (!templateDef || numberOfSupports > snCut || this.phasing) {
		if (numberOfSupports + numberOfQueuedSupports > supportNum || this.phasing)
		{
			let requirements;
			if (numberTotal < snCut * 2)
				requirements = [ ["speed", 0.5], ["costsResource", 0.5, "stone"], ["costsResource", 0.5, "metal"], ["canGather", 1] ];
			else
				requirements = [ ["strength", 1], ["canGather", 1] ];

			let classes = ["CitizenSoldier", "Infantry"];
			//  We want at least 33% ranged and 33% melee
/*
			if (numberOfRanged / numberOfInfantry < 0.5)
				classes.push("Ranged");
			else
				classes.push("Melee");
*/
			// Try to make use of barracks
			size = 10;
			mSize = size;
			template = this.findBestTrainableUnit(gameState, classes, requirements);
			actualTemplate = gameState.getTemplate(templateDef);
			cost = new API3.Resources(actualTemplate.cost());

//			KIARA.Logger.debug(uneval(cost));

			for (let r of Resources.GetCodes()) {
				if (!res[r])
					continue;
				size = Math.min(size, Math.floor(res[r]/cost[r]));
			}
			size = Math.max(size, min);
			mSize = Math.max(5, size);
		}
	}
	if (!size)
		return;
	let missing = pop - (gameState.getPopulationLimit() + (fHouse * pHouse));
	let skip = missing > 0;
	if (missing <= 0)
		missing += size;

	if (missing > 0) {
		this.wantPop = pop;
		while (nHouses < 3 && missing > 0) {
			let plan = new KIARA.ConstructionPlan(gameState, "structures/{civ}_house");
			// change the starting condition according to the situation.
			plan.goRequirement = "houseNeeded";
			queues.house.addPlan(plan);
			missing = missing - pHouse;
			nHouses++;
		}
		return;
		template = this.findBestTrainableUnit(gameState, classes, requirements);
	}

	// If the template variable is empty, the default unit (Support unit) will be used
	// base "0" means automatic choice of base
		if (template)
		queues.citizenSoldier.addPlan(new KIARA.TrainingPlan(gameState, template, { "role": "worker", "base": 0 }, size, mSize));
	else if (templateDef)
		queues.villager.addPlan(new KIARA.TrainingPlan(gameState, templateDef, { "role": "worker", "base": 0, "support": true }, size, mSize));
}

/** This code trains citizen workers, trying to keep close to a ratio of worker/soldiers */
KIARA.HQ.prototype.trainMoreWorkers = function(gameState, queues)
{
	this.alwaysTrain(gameState, queues);
};

KIARA.HQ.prototype.findBestTrainableUnitSpecial = function(gameState, classes, requirements, units)
{
	let anticlasses = [];
	if (classes.indexOf("Hero") != -1)
		anticlasses = ["Hero"];
	else if (classes.indexOf("Siege") != -1)	// We do not want siege tower as AI does not know how to use it
		anticlasses = ["SiegeTower"];

	units = gameState.filterTrainableUnitsByClass(units, classes, anticlasses);

	if (!units.length)
		return undefined;

	let parameters = requirements.slice();
	let remainingResources = this.getTotalResourceLevel(gameState);    // resources (estimation) still gatherable in our territory
	let availableResources = gameState.ai.queueManager.getAvailableResources(gameState); // available (gathered) resources
	for (let type in remainingResources)
	{
		if (availableResources[type] > 800)
			continue;
		if (remainingResources[type] > 800)
			continue;
		let costsResource = remainingResources[type] > 400 ? 0.6 : 0.2;
		let toAdd = true;
		for (let param of parameters)
		{
			if (param[0] != "costsResource" || param[2] != type)
				continue;
			param[1] = Math.min(param[1], costsResource);
			toAdd = false;
			break;
		}
		if (toAdd)
			parameters.push(["costsResource", costsResource, type]);
	}

	units.sort((a, b) => {
		let aCost = 1 + a[1].costSum();
		let bCost = 1 + b[1].costSum();
		let aValue = 0.1;
		let bValue = 0.1;
		for (let param of parameters)
		{
			if (param[0] == "strength")
			{
				aValue += KIARA.getMaxStrength(a[1], gameState.ai.Config.DamageTypeImportance) * param[1];
				bValue += KIARA.getMaxStrength(b[1], gameState.ai.Config.DamageTypeImportance) * param[1];
			}
			else if (param[0] == "siegeStrength")
			{
				aValue += KIARA.getMaxStrength(a[1], gameState.ai.Config.DamageTypeImportance, "Structure") * param[1];
				bValue += KIARA.getMaxStrength(b[1], gameState.ai.Config.DamageTypeImportance, "Structure") * param[1];
			}
			else if (param[0] == "speed")
			{
				aValue += a[1].walkSpeed() * param[1];
				bValue += b[1].walkSpeed() * param[1];
			}
			else if (param[0] == "costsResource")
			{
				// requires a third parameter which is the resource
				if (a[1].cost()[param[2]])
					aValue *= param[1];
				if (b[1].cost()[param[2]])
					bValue *= param[1];
			}
			else if (param[0] == "canGather")
			{
				// checking against wood, could be anything else really.
				if (a[1].resourceGatherRates() && a[1].resourceGatherRates()["wood.tree"])
					aValue *= param[1];
				if (b[1].resourceGatherRates() && b[1].resourceGatherRates()["wood.tree"])
					bValue *= param[1];
			}
			else
				KIARA.Logger.debug(" trainMoreUnits avec non prevu " + uneval(param));
		}
		return -aValue/aCost + bValue/bCost;
	});
	return units[0][0];
};


/** picks the best template based on parameters and classes */
KIARA.HQ.prototype.findBestTrainableUnit = function(gameState, classes, requirements)
{
	let units;
	if (classes.indexOf("Hero") != -1)
		units = gameState.findTrainableUnits(classes, []);
	else if (classes.indexOf("Siege") != -1)	// We do not want siege tower as AI does not know how to use it
		units = gameState.findTrainableUnits(classes, ["SiegeTower"]);
	else						// We do not want hero when not explicitely specified
		units = gameState.findTrainableUnits(classes, ["Hero"]);

	if (!units.length)
		return undefined;

	let parameters = requirements.slice();
	let remainingResources = this.getTotalResourceLevel(gameState);    // resources (estimation) still gatherable in our territory
	let availableResources = gameState.ai.queueManager.getAvailableResources(gameState); // available (gathered) resources
	for (let type in remainingResources)
	{
		if (availableResources[type] > 800)
			continue;
		if (remainingResources[type] > 800)
			continue;
		let costsResource = remainingResources[type] > 400 ? 0.6 : 0.2;
		let toAdd = true;
		for (let param of parameters)
		{
			if (param[0] != "costsResource" || param[2] != type)
				continue;
			param[1] = Math.min(param[1], costsResource);
			toAdd = false;
			break;
		}
		if (toAdd)
			parameters.push(["costsResource", costsResource, type]);
	}

	units.sort((a, b) => {
		let aCost = 1 + a[1].costSum();
		let bCost = 1 + b[1].costSum();
		let aValue = 0.1;
		let bValue = 0.1;
		for (let param of parameters)
		{
			if (param[0] == "strength")
			{
				aValue += KIARA.getMaxStrength(a[1], gameState.ai.Config.DamageTypeImportance) * param[1];
				bValue += KIARA.getMaxStrength(b[1], gameState.ai.Config.DamageTypeImportance) * param[1];
			}
			else if (param[0] == "siegeStrength")
			{
				aValue += KIARA.getMaxStrength(a[1], gameState.ai.Config.DamageTypeImportance, "Structure") * param[1];
				bValue += KIARA.getMaxStrength(b[1], gameState.ai.Config.DamageTypeImportance, "Structure") * param[1];
			}
			else if (param[0] == "speed")
			{
				aValue += a[1].walkSpeed() * param[1];
				bValue += b[1].walkSpeed() * param[1];
			}
			else if (param[0] == "costsResource")
			{
				// requires a third parameter which is the resource
				if (a[1].cost()[param[2]])
					aValue *= param[1];
				if (b[1].cost()[param[2]])
					bValue *= param[1];
			}
			else if (param[0] == "canGather")
			{
				// checking against wood, could be anything else really.
				if (a[1].resourceGatherRates() && a[1].resourceGatherRates()["wood.tree"])
					aValue *= param[1];
				if (b[1].resourceGatherRates() && b[1].resourceGatherRates()["wood.tree"])
					bValue *= param[1];
			}
			else
				KIARA.Logger.debug(" trainMoreUnits avec non prevu " + uneval(param));
		}
		return -aValue/aCost + bValue/bCost;
	});
	return units[0][0];
};

KIARA.HQ.prototype.bulkPickBuilders = function(gameState, baseRef, number)
{
	let accessIndex = baseRef.accessIndex;
	if (!accessIndex)
		return false;
	// sorting bases by whether they are on the same accessindex or not.
	let baseBest = this.baseManagers.slice().sort((a, b) => {
		if (a.accessIndex == accessIndex && b.accessIndex != accessIndex)
			return -1;
		else if (b.accessIndex == accessIndex && a.accessIndex != accessIndex)
			return 1;
		return 0;
	});

	let needed = number;
	let workers = new API3.EntityCollection(gameState.sharedScript);
	// pick free builders from another base
	let myBase;
	for (let base of baseBest)
	{
		if (base.ID == baseRef) {
			myBase = base;
			continue;
		}
		base.pickBuilders(gameState, workers, needed, true, false);
		if (workers.length >= number)
			break;
		needed = number - workers.length;
	}
	if (workers.length >= number)
		return workers;
	// pick whoever from own base
	if (myBase)
		myBase.pickBuilders(gameState, workers, needed, false, true);
	if (workers.length >= number)
		return workers;
	// pick whoever from another base
	for (let base of baseBest)
	{
		base.pickBuilders(gameState, workers, needed, false, true);
		if (workers.length >= number)
			break;
		needed = number - workers.length;
	}
	if (!workers.length) {
		return false;
	}
	return workers;
};

/**
 * returns an entity collection of workers through BaseManager.pickBuilders
 * TODO: when same accessIndex, sort by distance
 */
KIARA.HQ.prototype.bulkPickWorkers = function(gameState, baseRef, number)
{
	let accessIndex = baseRef.accessIndex;
	if (!accessIndex)
		return false;
	// sorting bases by whether they are on the same accessindex or not.
	let baseBest = this.baseManagers.slice().sort((a, b) => {
		if (a.accessIndex == accessIndex && b.accessIndex != accessIndex)
			return -1;
		else if (b.accessIndex == accessIndex && a.accessIndex != accessIndex)
			return 1;
		return 0;
	});

	let needed = number;
	let workers = new API3.EntityCollection(gameState.sharedScript);
	for (let base of baseBest)
	{
		if (base.ID == baseRef.ID)
			continue;
		base.pickBuilders(gameState, workers, needed);
		if (workers.length >= number)
			break;
		needed = number - workers.length;
	}
	if (!workers.length)
		return false;
	return workers;
};

KIARA.HQ.prototype.getTotalResourceLevel = function(gameState)
{
	let total = {};
	for (let res of Resources.GetCodes())
		total[res] = 0;
	for (let base of this.baseManagers)
		for (let res in total)
			total[res] += base.getResourceLevel(gameState, res);

	return total;
};

/**
 * Returns the current gather rate
 * This is not per-se exact, it performs a few adjustments ad-hoc to account for travel distance, stuffs like that.
 */
KIARA.HQ.prototype.GetCurrentGatherRates = function(gameState)
{
	if (!this.turnCache.currentRates)
	{
		let currentRates = {};
		for (let res of Resources.GetCodes())
			currentRates[res] = this.GetTCResGatherer(res);

		for (let base of this.baseManagers)
			base.addGatherRates(gameState, currentRates);

		for (let res of Resources.GetCodes())
			currentRates[res] = Math.max(currentRates[res], 0);

		this.turnCache.currentRates = currentRates;
	}

	return this.turnCache.currentRates;
};

/**
 * Returns the wanted gather rate.
 */
KIARA.HQ.prototype.GetWantedGatherRates = function(gameState)
{
	if (!this.turnCache.wantedRates)
		this.turnCache.wantedRates = gameState.ai.queueManager.wantedGatherRates(gameState);

	return this.turnCache.wantedRates;
};

/**
 * Pick the resource which most needs another worker
 * How this works:
 * We get the rates we would want to have to be able to deal with our plans
 * We get our current rates
 * We compare; we pick the one where the discrepancy is highest.
 * Need to balance long-term needs and possible short-term needs.
 */
KIARA.HQ.prototype.pickMostNeededResources = function(gameState, allowedResources = [])
{
	let wantedRates = this.GetWantedGatherRates(gameState);
	let currentRates = this.GetCurrentGatherRates(gameState);
	if (!allowedResources.length)
		allowedResources = Resources.GetCodes();

	let needed = [];
	for (let res of allowedResources)
		needed.push({ "type": res, "wanted": wantedRates[res], "current": currentRates[res] });

	needed.sort((a, b) => {
		if (a.current < a.wanted && b.current < b.wanted)
		{
			if (a.current && b.current)
				return b.wanted / b.current - a.wanted / a.current;
			if (a.current)
				return 1;
			if (b.current)
				return -1;
			return b.wanted - a.wanted;
		}
		if (a.current < a.wanted || a.wanted && !b.wanted)
			return -1;
		if (b.current < b.wanted || b.wanted && !a.wanted)
			return 1;
		return a.current - a.wanted - b.current + b.wanted;
	});
	return needed;
};

/**
 * Returns the best position to build a new Civil Center
 * Whose primary function would be to reach new resources of type "resource".
 */
KIARA.HQ.prototype.findEconomicCCLocation = function(gameState, template, resource, proximity, fromStrategic)
{
	// This builds a map. The procedure is fairly simple. It adds the resource maps
	//	(which are dynamically updated and are made so that they will facilitate DP placement)
	// Then look for a good spot.

	Engine.ProfileStart("findEconomicCCLocation");

	// obstruction map
	let obstructions = KIARA.createObstructionMap(gameState, 0, template);
	let halfSize = 0;
	if (template.get("Footprint/Square"))
		halfSize = Math.max(+template.get("Footprint/Square/@depth"), +template.get("Footprint/Square/@width")) / 2;
	else if (template.get("Footprint/Circle"))
		halfSize = +template.get("Footprint/Circle/@radius");

	let ccEnts = gameState.updatingGlobalCollection("allCCs", API3.Filters.byClass("CivCentre"));
	let dpEnts = gameState.getOwnDropsites().filter(API3.Filters.not(API3.Filters.byClassesOr(["CivCentre", "Unit"])));
	let ccList = [];
	for (let cc of ccEnts.values())
		ccList.push({ "ent": cc, "pos": cc.position(), "ally": gameState.isPlayerAlly(cc.owner()) });
	let dpList = [];
	for (let dp of dpEnts.values())
		dpList.push({ "ent": dp, "pos": dp.position(), "territory": this.territoryMap.getOwner(dp.position()) });

	let bestIdx;
	let bestVal;
	let radius = Math.ceil(template.obstructionRadius().max / obstructions.cellSize);
	let scale = 250 * 250;
	let proxyAccess;
	let nbShips = this.navalManager.transportShips.length;
	if (proximity)	// this is our first base
	{
		// if our first base, ensure room around
		radius = Math.ceil((template.obstructionRadius().max + 8) / obstructions.cellSize);
		// scale is the typical scale at which we want to find a location for our first base
		// look for bigger scale if we start from a ship (access < 2) or from a small island
		let cellArea = gameState.getPassabilityMap().cellSize * gameState.getPassabilityMap().cellSize;
		proxyAccess = gameState.ai.accessibility.getAccessValue(proximity);
		if (proxyAccess < 2 || cellArea*gameState.ai.accessibility.regionSize[proxyAccess] < 24000)
			scale = 400 * 400;
	}

	let width = this.territoryMap.width;
	let cellSize = this.territoryMap.cellSize;

	// DistanceSquare cuts to other ccs (bigger or no cuts on inaccessible ccs to allow colonizing other islands).
	let nearbyRejected = Math.square(120);			// Reject if too near from any cc
	let nearbyAllyRejected = Math.square(200);		// Reject if too near from an allied cc
	let nearbyAllyDisfavored = Math.square(250);		// Disfavor if quite near an allied cc
	let maxAccessRejected = Math.square(410);		// Reject if too far from an accessible ally cc
	let maxAccessDisfavored = Math.square(330);	// Disfavor if quite far from an accessible ally cc
	let maxNoAccessDisfavored = Math.square(500);		// Disfavor if quite far from an inaccessible ally cc

	let cut = 60;
	if (fromStrategic || proximity)  // be less restrictive
		cut = 30;

	for (let j = 0; j < this.territoryMap.length; ++j)
	{
		if (this.territoryMap.getOwnerIndex(j) != 0)
			continue;
		// With enough room around to build the cc
		let i = this.territoryMap.getNonObstructedTile(j, radius, obstructions);
		if (i < 0)
			continue;
		// We require that it is accessible
		let index = gameState.ai.accessibility.landPassMap[i];
		if (!this.landRegions[index])
			continue;
		if (proxyAccess && nbShips == 0 && proxyAccess != index)
			continue;

		let norm = 0.5;   // TODO adjust it, knowing that we will sum 5 maps
		// Checking distance to other cc
		let pos = [cellSize * (j%width+0.5), cellSize * (Math.floor(j/width)+0.5)];
		// We will be more tolerant for cc around our oversea docks
		let oversea = false;

		if (proximity)	// This is our first cc, let's do it near our units
			norm /= 1 + API3.SquareVectorDistance(proximity, pos) / scale;
		else
		{
			let minDist = Math.min();
			let accessible = false;

			for (let cc of ccList)
			{
				let dist = API3.SquareVectorDistance(cc.pos, pos);
				if (dist < nearbyRejected)
				{
					norm = 0;
					break;
				}
				if (!cc.ally)
					continue;
				if (dist < nearbyAllyRejected)
				{
					norm = 0;
					break;
				}
				if (dist < nearbyAllyDisfavored)
					norm *= 0.5;

				if (dist < minDist)
					minDist = dist;
				accessible = accessible || index == KIARA.getLandAccess(gameState, cc.ent);
			}
			if (norm == 0)
				continue;

			if (accessible && minDist > maxAccessRejected)
				continue;

			if (minDist > maxAccessDisfavored)     // Disfavor if quite far from any allied cc
			{
				if (!accessible)
				{
					if (minDist > maxNoAccessDisfavored)
						norm *= 0.5;
					else
						norm *= 0.8;
				}
				else
					norm *= 0.5;
			}

			// Not near any of our dropsite, except for oversea docks
			oversea = !accessible && dpList.some(dp => KIARA.getLandAccess(gameState, dp.ent) == index);
			if (!oversea)
			{
				for (let dp of dpList)
				{
					let dist = API3.SquareVectorDistance(dp.pos, pos);
					if (dist < 3600)
					{
						norm = 0;
						break;
					}
					else if (dist < 6400)
						norm *= 0.5;
				}
			}
			if (norm == 0)
				continue;
		}

		if (this.borderMap.map[j] & KIARA.fullBorder_Mask)	// disfavor the borders of the map
			norm *= 0.5;

		let val = 2 * gameState.sharedScript.ccResourceMaps[resource].map[j];
		for (let res in gameState.sharedScript.resourceMaps)
			if (res != "food")
				val += gameState.sharedScript.ccResourceMaps[res].map[j];
		val *= norm;

		// If oversea, be just above threshold to be accepted if nothing else
		if (oversea)
			val = Math.max(val, cut + 0.1);

		if (bestVal !== undefined && val < bestVal)
			continue;
		if (this.isDangerousLocation(gameState, pos, halfSize))
			continue;
		bestVal = val;
		bestIdx = i;
	}

	Engine.ProfileStop();

	if (bestVal === undefined)
		return false;
	KIARA.Logger.debug("we have found a base for " + resource + " with best (cut=" + cut + ") = " + bestVal);
	// not good enough.
	if (bestVal < cut)
		return false;

	let x = (bestIdx % obstructions.width + 0.5) * obstructions.cellSize;
	let z = (Math.floor(bestIdx / obstructions.width) + 0.5) * obstructions.cellSize;

	// Define a minimal number of wanted ships in the seas reaching this new base
	let indexIdx = gameState.ai.accessibility.landPassMap[bestIdx];
	for (let base of this.baseManagers)
	{
		if (!base.anchor || base.accessIndex == indexIdx)
			continue;
		let sea = this.getSeaBetweenIndices(gameState, base.accessIndex, indexIdx);
		if (sea !== undefined)
			this.navalManager.setMinimalTransportShips(gameState, sea, 1);
	}

	return [x, z];
};

/**
 * Returns the best position to build a new Civil Center
 * Whose primary function would be to assure territorial continuity with our allies
 */
KIARA.HQ.prototype.findStrategicCCLocation = function(gameState, template)
{
	// This builds a map. The procedure is fairly simple.
	// We minimize the Sum((dist - 300)^2) where the sum is on the three nearest allied CC
	// with the constraints that all CC have dist > 200 and at least one have dist < 400
	// This needs at least 2 CC. Otherwise, go back to economic CC.

	let ccEnts = gameState.updatingGlobalCollection("allCCs", API3.Filters.byClass("CivCentre"));
	let ccList = [];
	let numAllyCC = 0;
	for (let cc of ccEnts.values())
	{
		let ally = gameState.isPlayerAlly(cc.owner());
		ccList.push({ "pos": cc.position(), "ally": ally });
		if (ally)
			++numAllyCC;
	}
	if (numAllyCC < 2)
		return this.findEconomicCCLocation(gameState, template, "wood", undefined, true);

	Engine.ProfileStart("findStrategicCCLocation");

	// obstruction map
	let obstructions = KIARA.createObstructionMap(gameState, 0, template);
	let halfSize = 0;
	if (template.get("Footprint/Square"))
		halfSize = Math.max(+template.get("Footprint/Square/@depth"), +template.get("Footprint/Square/@width")) / 2;
	else if (template.get("Footprint/Circle"))
		halfSize = +template.get("Footprint/Circle/@radius");

	let bestIdx;
	let bestVal;
	let radius = Math.ceil(template.obstructionRadius().max / obstructions.cellSize);

	let width = this.territoryMap.width;
	let cellSize = this.territoryMap.cellSize;
	let currentVal, delta;
	let distcc0, distcc1, distcc2;
	let favoredDistance = 220;

	for (let j = 0; j < this.territoryMap.length; ++j)
	{
		if (this.territoryMap.getOwnerIndex(j) != 0)
			continue;
		// with enough room around to build the cc
		let i = this.territoryMap.getNonObstructedTile(j, radius, obstructions);
		if (i < 0)
			continue;
		// we require that it is accessible
		let index = gameState.ai.accessibility.landPassMap[i];
		if (!this.landRegions[index])
			continue;

		// checking distances to other cc
		let pos = [cellSize * (j%width+0.5), cellSize * (Math.floor(j/width)+0.5)];
		let minDist = Math.min();
		distcc0 = undefined;

		for (let cc of ccList)
		{
			let dist = API3.SquareVectorDistance(cc.pos, pos);
			if (dist < 14000)    // Reject if too near from any cc
			{
				minDist = 0;
				break;
			}
			if (!cc.ally)
				continue;
			if (dist < 62000)    // Reject if quite near from ally cc
			{
				minDist = 0;
				break;
			}
			if (dist < minDist)
				minDist = dist;

			if (!distcc0 || dist < distcc0)
			{
				distcc2 = distcc1;
				distcc1 = distcc0;
				distcc0 = dist;
			}
			else if (!distcc1 || dist < distcc1)
			{
				distcc2 = distcc1;
				distcc1 = dist;
			}
			else if (!distcc2 || dist < distcc2)
				distcc2 = dist;
		}
		if (minDist < 1 || minDist > 170000 && !this.navalMap)
			continue;

		delta = Math.sqrt(distcc0) - favoredDistance;
		currentVal = delta*delta;
		delta = Math.sqrt(distcc1) - favoredDistance;
		currentVal += delta*delta;
		if (distcc2)
		{
			delta = Math.sqrt(distcc2) - favoredDistance;
			currentVal += delta*delta;
		}
		// disfavor border of the map
		if (this.borderMap.map[j] & KIARA.fullBorder_Mask)
			currentVal += 10000;

		if (bestVal !== undefined && currentVal > bestVal)
			continue;
		if (this.isDangerousLocation(gameState, pos, halfSize))
			continue;
		bestVal = currentVal;
		bestIdx = i;
	}

	KIARA.Logger.debug("We've found a strategic base with bestVal = " + bestVal);

	Engine.ProfileStop();

	if (bestVal === undefined)
		return undefined;

	let x = (bestIdx % obstructions.width + 0.5) * obstructions.cellSize;
	let z = (Math.floor(bestIdx / obstructions.width) + 0.5) * obstructions.cellSize;

	// Define a minimal number of wanted ships in the seas reaching this new base
	let indexIdx = gameState.ai.accessibility.landPassMap[bestIdx];
	for (let base of this.baseManagers)
	{
		if (!base.anchor || base.accessIndex == indexIdx)
			continue;
		let sea = this.getSeaBetweenIndices(gameState, base.accessIndex, indexIdx);
		if (sea !== undefined)
			this.navalManager.setMinimalTransportShips(gameState, sea, 1);
	}

	return [x, z];
};

/**
 * Returns the best position to build a new market: if the allies already have a market, build it as far as possible
 * from it, although not in our border to be able to defend it easily. If no allied market, our second market will
 * follow the same logic.
 * To do so, we suppose that the gain/distance is an increasing function of distance and look for the max distance
 * for performance reasons.
 */
KIARA.HQ.prototype.findMarketLocation = function(gameState, template)
{
	let markets = gameState.updatingCollection("diplo-ExclusiveAllyMarkets", API3.Filters.byClass("Trade"), gameState.getExclusiveAllyEntities()).toEntityArray();
	if (!markets.length)
		markets = gameState.updatingCollection("OwnMarkets", API3.Filters.byClass("Trade"), gameState.getOwnStructures()).toEntityArray();

	if (!markets.length)	// this is the first market. For the time being, place it arbitrarily by the ConstructionPlan
		return [-1, -1, -1, 0];

	// No need for more than one market when we cannot trade.
	if (!Resources.GetTradableCodes().length)
		return false;

	// obstruction map
	let obstructions = KIARA.createObstructionMap(gameState, 0, template);
	let halfSize = 0;
	if (template.get("Footprint/Square"))
		halfSize = Math.max(+template.get("Footprint/Square/@depth"), +template.get("Footprint/Square/@width")) / 2;
	else if (template.get("Footprint/Circle"))
		halfSize = +template.get("Footprint/Circle/@radius");

	let bestIdx;
	let bestJdx;
	let bestVal;
	let bestDistSq;
	let bestGainMult;
	let radius = Math.ceil(template.obstructionRadius().max / obstructions.cellSize);
	let isNavalMarket = template.hasClass("Naval") && template.hasClass("Trade");

	let width = this.territoryMap.width;
	let cellSize = this.territoryMap.cellSize;

	let traderTemplatesGains = gameState.getTraderTemplatesGains();

	for (let j = 0; j < this.territoryMap.length; ++j)
	{
		// do not try on the narrow border of our territory
		if (this.borderMap.map[j] & KIARA.narrowFrontier_Mask)
			continue;
		if (this.basesMap.map[j] == 0)   // only in our territory
			continue;
		// with enough room around to build the market
		let i = this.territoryMap.getNonObstructedTile(j, radius, obstructions);
		if (i < 0)
			continue;
		let index = gameState.ai.accessibility.landPassMap[i];
		if (!this.landRegions[index])
			continue;
		let pos = [cellSize * (j%width+0.5), cellSize * (Math.floor(j/width)+0.5)];
		// checking distances to other markets
		let maxVal = 0;
		let maxDistSq;
		let maxGainMult;
		let gainMultiplier;
		for (let market of markets)
		{
			if (isNavalMarket && template.hasClass("Naval") && template.hasClass("Trade"))
			{
				if (KIARA.getSeaAccess(gameState, market) != gameState.ai.accessibility.getAccessValue(pos, true))
					continue;
				gainMultiplier = traderTemplatesGains.navalGainMultiplier;
			}
			else if (KIARA.getLandAccess(gameState, market) == index &&
				!KIARA.isLineInsideEnemyTerritory(gameState, market.position(), pos))
				gainMultiplier = traderTemplatesGains.landGainMultiplier;
			else
				continue;
			if (!gainMultiplier)
				continue;
			let distSq = API3.SquareVectorDistance(market.position(), pos);
			if (gainMultiplier * distSq > maxVal)
			{
				maxVal = gainMultiplier * distSq;
				maxDistSq = distSq;
				maxGainMult = gainMultiplier;
			}
		}
		if (maxVal == 0)
			continue;
		if (bestVal !== undefined && maxVal < bestVal)
			continue;
		if (this.isDangerousLocation(gameState, pos, halfSize))
			continue;
		bestVal = maxVal;
		bestDistSq = maxDistSq;
		bestGainMult = maxGainMult;
		bestIdx = i;
		bestJdx = j;
	}

	KIARA.Logger.debug("We found a market position with bestVal = " + bestVal);

	if (bestVal === undefined)  // no constraints. For the time being, place it arbitrarily by the ConstructionPlan
		return [-1, -1, -1, 0];
	let expectedGain = Math.round(bestGainMult * TradeGain(bestDistSq, gameState.sharedScript.mapSize));
	KIARA.Logger.debug("this would give a trading gain of " + expectedGain);
	// Do not keep it if gain is too small, except if this is our first Market.
	let idx;
	if (expectedGain < this.tradeManager.minimalGain)
	{
		if (template.hasClass("Market") &&
		    !gameState.getOwnEntitiesByClass("Market", true).hasEntities())
			idx = -1; // Needed by queueplanBuilding manager to keep that Market.
		else
			return false;
	}
	else
		idx = this.basesMap.map[bestJdx];

	let x = (bestIdx % obstructions.width + 0.5) * obstructions.cellSize;
	let z = (Math.floor(bestIdx / obstructions.width) + 0.5) * obstructions.cellSize;
	return [x, z, idx, expectedGain];
};

/**
 * Returns the best position to build defensive buildings (fortress and towers)
 * Whose primary function is to defend our borders
 */
KIARA.HQ.prototype.findDefensiveLocation = function(gameState, template)
{
	// We take the point in our territory which is the nearest to any enemy cc
	// but requiring a minimal distance with our other defensive structures
	// and not in range of any enemy defensive structure to avoid building under fire.

	let ownStructures = gameState.getOwnStructures().filter(API3.Filters.byClassesOr(["Fortress", "Tower"])).toEntityArray();
	let enemyStructures = gameState.getEnemyStructures().filter(API3.Filters.not(API3.Filters.byOwner(0))).
		filter(API3.Filters.byClassesOr(["CivCentre", "Fortress", "Tower"]));
	if (!enemyStructures.hasEntities())	// we may be in cease fire mode, build defense against neutrals
	{
		enemyStructures = gameState.getNeutralStructures().filter(API3.Filters.not(API3.Filters.byOwner(0))).
			filter(API3.Filters.byClassesOr(["CivCentre", "Fortress", "Tower"]));
		if (!enemyStructures.hasEntities() && !gameState.getAlliedVictory())
			enemyStructures = gameState.getAllyStructures().filter(API3.Filters.not(API3.Filters.byOwner(PlayerID))).
				filter(API3.Filters.byClassesOr(["CivCentre", "Fortress", "Tower"]));
		if (!enemyStructures.hasEntities())
			return undefined;
	}
	enemyStructures = enemyStructures.toEntityArray();

	let wonderMode = gameState.getVictoryConditions().has("wonder");
	let wonderDistmin;
	let wonders;
	let ccs;
	let ccsDistmin;
	if (wonderMode)
	{
		wonders = gameState.getOwnStructures().filter(API3.Filters.byClass("Wonder")).toEntityArray();
		wonderMode = wonders.length != 0;
	}
	if (wonderMode)
		wonderDistmin = (50 + wonders[0].footprintRadius()) * (50 + wonders[0].footprintRadius());
	else {
		ccs = gameState.getOwnStructures().filter(API3.Filters.byClass("CivCentre")).toEntityArray();
		if (ccs.length)
			ccsDistmin = (50 + ccs[0].footprintRadius()) * (50 + ccs[0].footprintRadius());
	}

	// obstruction map
	let obstructions = KIARA.createObstructionMap(gameState, 0, template);
	let halfSize = 0;
	if (template.get("Footprint/Square"))
		halfSize = Math.max(+template.get("Footprint/Square/@depth"), +template.get("Footprint/Square/@width")) / 2;
	else if (template.get("Footprint/Circle"))
		halfSize = +template.get("Footprint/Circle/@radius");

	let bestIdx;
	let bestJdx;
	let bestVal;
	let width = this.territoryMap.width;
	let cellSize = this.territoryMap.cellSize;

	let isTower = template.hasClass("Tower");
	let isFortress = template.hasClass("Fortress");
	let radius;
	if (isFortress)
		radius = Math.floor((template.obstructionRadius().max + 8) / obstructions.cellSize);
	else
		radius = Math.ceil(template.obstructionRadius().max / obstructions.cellSize);

	for (let j = 0; j < this.territoryMap.length; ++j)
	{
		if (!wonderMode)
		{
			// do not try if well inside or outside territory
			if (!(this.borderMap.map[j] & KIARA.fullFrontier_Mask))
				continue;
			if (this.borderMap.map[j] & KIARA.largeFrontier_Mask && isTower)
				continue;
		}
		if (this.basesMap.map[j] == 0)   // inaccessible cell
			continue;
		// with enough room around to build the cc
		let i = this.territoryMap.getNonObstructedTile(j, radius, obstructions);
		if (i < 0)
			continue;

		let pos = [cellSize * (j%width+0.5), cellSize * (Math.floor(j/width)+0.5)];
		// checking distances to other structures
		let minDist = Math.min();

		let dista = 0;
		if (wonderMode)
		{
			dista = API3.SquareVectorDistance(wonders[0].position(), pos);
			if (dista < wonderDistmin)
				continue;
			dista *= 200;   // empirical factor (TODO should depend on map size) to stay near the wonder
		}

		for (let str of enemyStructures)
		{
			if (str.foundationProgress() !== undefined)
				continue;
			let strPos = str.position();
			if (!strPos)
				continue;
			let dist = API3.SquareVectorDistance(strPos, pos);
			let ranged = str.attackRange("Ranged");
			let range = halfSize + ranged.max + ranged.elevationBonus;
			if (dist < range * range)			{
				minDist = -1;
				break;
			}
			if (str.hasClass("CivCentre") && dist + dista < minDist)
				minDist = dist + dista;
		}
		if (minDist < 0)
			continue;

		let cutDist = 900;  // 30×30 TODO maybe increase it
		for (let str of ownStructures)
		{
			let strPos = str.position();
			if (!strPos)
				continue;
			if (API3.SquareVectorDistance(strPos, pos) < cutDist)
			{
				minDist = -1;
				break;
			}
		}
		if (minDist < 0 || minDist == Math.min())
			continue;
		if (bestVal !== undefined && minDist > bestVal)
			continue;
		if (this.isDangerousLocation(gameState, pos, halfSize))
			continue;
		bestVal = minDist;
		bestIdx = i;
		bestJdx = j;
	}

	if (bestVal === undefined)
		return undefined;

	let x = (bestIdx % obstructions.width + 0.5) * obstructions.cellSize;
	let z = (Math.floor(bestIdx / obstructions.width) + 0.5) * obstructions.cellSize;
	return [x, z, this.basesMap.map[bestJdx], bestIdx];
};

KIARA.HQ.prototype.buildTemple = function(gameState, queues)
{
	// at least one market (which have the same queue) should be build before any temple
	if (queues.economicBuilding.hasQueuedUnits() ||
		gameState.getOwnEntitiesByClass("Temple", true).hasEntities() ||
		!gameState.getOwnEntitiesByClass("Market", true).hasEntities())
		return;
	// Try to build a temple earlier if in regicide to recruit healer guards
	if (this.currentPhase < 3 && !gameState.getVictoryConditions().has("regicide"))
		return;

	let templateName = "structures/{civ}/temple";
	if (this.canBuild(gameState, "structures/{civ}/temple_vesta"))
		templateName = "structures/{civ}/temple_vesta";
	else if (!this.canBuild(gameState, templateName))
		return;
	queues.economicBuilding.addPlan(new KIARA.ConstructionPlan(gameState, templateName));
};

KIARA.HQ.prototype.buildMarket = function(gameState, queues)
{
	if (gameState.getOwnEntitiesByClass("Market", true).hasEntities() ||
		!this.canBuild(gameState, KIARA.Templates[KIARA.TemplateConstants.Market]))
		return;

	if (queues.economicBuilding.hasQueuedUnitsWithClass("Market"))
	{
		if (!queues.economicBuilding.paused)
		{
			// Put available resources in this market
			let queueManager = gameState.ai.queueManager;
			let cost = queues.economicBuilding.plans[0].getCost();
			queueManager.setAccounts(gameState, cost, "economicBuilding");
			if (!queueManager.canAfford("economicBuilding", cost))
			{
				for (let q in queueManager.queues)
				{
					if (q == "economicBuilding")
						continue;
					queueManager.transferAccounts(cost, q, "economicBuilding");
					if (queueManager.canAfford("economicBuilding", cost))
						break;
				}
			}
		}
		return;
	}

	gameState.ai.queueManager.changePriority("economicBuilding", 3 * this.Config.priorities.economicBuilding);
	let plan = new KIARA.ConstructionPlan(gameState, KIARA.Templates[KIARA.TemplateConstants.Market]);
	plan.queueToReset = "economicBuilding";
	queues.economicBuilding.addPlan(plan);
};

/** Build a farmstead */
KIARA.HQ.prototype.buildFoodSupply = function(gameState, queues, type, res)
{
		if (!gameState.isTemplateAvailable(gameState.applyCiv(KIARA.Templates[KIARA.TemplateConstants.Farmstead])))
		return false;

	for (let x = 1; x < this.numActiveBases() + 1; x++) {
		let newSF = this.baseManagers[x].findBestFarmsteadLocation(gameState, res);
		if (newSF.quality > 10) {
			queues[type].addPlan(new KIARA.ConstructionPlan(gameState, KIARA.Templates[KIARA.TemplateConstants.Farmstead], {"base": this.baseManagers[x].ID, "type": "food"}, newSF.pos));
	//		KIARA.Logger.debug("Build food supply for " + res);
			return true;
		}
	}

	return false;
}

/** Build field */
KIARA.HQ.prototype.buildField = function(gameState, queues)
{
	if (!this.canBuild(gameState, KIARA.Templates[KIARA.TemplateConstants.Field]))
	// Only build one farmstead for the time being ("DropsiteFood" does not refer to CCs)
	if (gameState.getOwnEntitiesByClass("Farmstead", true).hasEntities())
		return;
	// Wait to have at least one dropsite and house before the farmstead
	if (!gameState.getOwnEntitiesByClass("Storehouse", true).hasEntities())
		return;
	if (!gameState.getOwnEntitiesByClass("House", true).hasEntities())
		return;
	if (queues.economicBuilding.hasQueuedUnitsWithClass("DropsiteFood"))
		return;
	if (!this.canBuild(gameState, KIARA.Templates[KIARA.TemplateConstants.Field]))
		return;

	queues.economicBuilding.addPlan(new KIARA.ConstructionPlan(gameState, KIARA.Templates[KIARA.TemplateConstants.Field]));
};

/**
 * Try to build a wonder when required
 * force = true when called from the victoryManager in case of Wonder victory condition.
 */
KIARA.HQ.prototype.buildWonder = function(gameState, queues, force = false)
{
	if (queues.wonder && queues.wonder.hasQueuedUnits() ||
	    gameState.getOwnEntitiesByClass("Wonder", true).hasEntities() ||
	    !this.canBuild(gameState, KIARA.Templates[KIARA.TemplateConstants.Wonder]))
		return;

	if (!force)
	{
		let template = gameState.getTemplate(gameState.applyCiv(KIARA.Templates[KIARA.TemplateConstants.Wonder]));
		// Check that we have enough resources to start thinking to build a wonder
		let cost = template.cost();
		let resources = gameState.getResources();
		let highLevel = 0;
		let lowLevel = 0;
		for (let res in cost)
		{
			if (resources[res] && resources[res] > 0.7 * cost[res])
				++highLevel;
			else if (!resources[res] || resources[res] < 0.3 * cost[res])
				++lowLevel;
		}
		if (highLevel == 0 || lowLevel > 1)
			return;
	}

	queues.wonder.addPlan(new KIARA.ConstructionPlan(gameState, KIARA.Templates[KIARA.TemplateConstants.Wonder]));
};

/** Build a corral, and train animals there */
KIARA.HQ.prototype.manageCorral = function(gameState, queues)
{
	if (queues.corral.hasQueuedUnits())
		return;

	let nCorral = gameState.getOwnEntitiesByClass("Corral", true).length;
	if (!nCorral || !gameState.isTemplateAvailable(gameState.applyCiv(KIARA.Templates[KIARA.TemplateConstants.Field])) &&
	                nCorral < this.currentPhase && gameState.getPopulation() > 30 * nCorral)
	{
		if (this.canBuild(gameState, KIARA.Templates[KIARA.TemplateConstants.Corral]))
		{
			queues.corral.addPlan(new KIARA.ConstructionPlan(gameState, KIARA.Templates[KIARA.TemplateConstants.Corral]));
			return;
		}
		if (!nCorral)
			return;
	}

	// And train some animals
	let civ = gameState.getPlayerCiv();
	for (let corral of gameState.getOwnEntitiesByClass("Corral", true).values())
	{
		if (corral.foundationProgress() !== undefined)
			continue;
		let trainables = corral.trainableEntities(civ);
		for (let trainable of trainables)
		{
			if (gameState.isTemplateDisabled(trainable))
				continue;
			let template = gameState.getTemplate(trainable);
			if (!template || !template.isHuntable())
				continue;
			let count = gameState.countEntitiesByType(trainable, true);
			for (let item of corral.trainingQueue())
				count += item.count;
			if (count > nCorral * this.huntCav)
				continue;
			queues.corral.addPlan(new KIARA.TrainingPlan(gameState, trainable, { "trainer": corral.id() }, 5));
			return;
		}
	}
};

KIARA.HQ.prototype.signalNoSupply = function(gameState, resource)
{
	if (this.needDropsite[resource])
		return;
//	KIARA.Logger.debug("need supply " + resource);
	this.needDropsite[resource] = true;
}

KIARA.HQ.prototype.signalNoNeedSupply = function(gameState, resource)
{
	if (!this.needDropsite[resource])
		return;
//	KIARA.Logger.debug("noo need supply " + resource);
	this.needDropsite[resource] = false;
}

KIARA.HQ.prototype.buildDropsite = function(gameState, queues, type, res)
{
	if (res == "food" || res == "farm")
		return this.buildFoodSupply(gameState, queues, type, res);
	if (!gameState.isTemplateAvailable(gameState.applyCiv(KIARA.Templates[KIARA.TemplateConstants.Dropsite]))) {
		KIARA.Logger.debug("signalNoSupply: cannot build storehouse");
		return false;
	}
	let cut = 20;
	if (res == "wood")
		cut = 40;
	for (let x = 1; x < this.numActiveBases() + 1; x++) {
		let newDP = this.baseManagers[x].findBestDropsiteLocation(gameState, res);
		if (newDP.quality > cut) {
		//	warn("build new dropsite for " + res);
			queues[type].addPlan(new KIARA.ConstructionPlan(gameState, KIARA.Templates[KIARA.TemplateConstants.Dropsite], {"base": this.baseManagers[x].ID, "type": res}, newDP.pos));
			return true;
		} else {
	//		warn("rejected dropsite for " + res + " with " + newDP.quality);
		}
	}
	return false;
}

/**
 * build more houses if needed.
 * kinda ugly, lots of special cases to both build enough houses but not tooo many…
 */
KIARA.HQ.prototype.buildMoreHouses = function(gameState, queues)
{
	let houseTemplateString = KIARA.Templates[KIARA.TemplateConstants.MorePopulationAdv];
	if (!gameState.isTemplateAvailable(gameState.applyCiv(houseTemplateString)) ||
		!this.canBuild(gameState, houseTemplateString))
	{
		houseTemplateString = KIARA.Templates[KIARA.TemplateConstants.MorePopulation];
		if (!gameState.isTemplateAvailable(gameState.applyCiv(houseTemplateString)))
			return;
	}
	if (gameState.getPopulationMax() <= gameState.getPopulationLimit())
		return;

	let numPlanned = queues.house.length();
	if (numPlanned < 3 || numPlanned < 5 && gameState.getPopulation() > 80)
	{
		let plan = new KIARA.ConstructionPlan(gameState, houseTemplateString);
		// change the starting condition according to the situation.
		plan.goRequirement = "houseNeeded";
		queues.house.addPlan(plan);
	}

	if (numPlanned > 0 && this.phasing && gameState.getPhaseEntityRequirements(this.phasing).length)
	{
		let houseTemplateName = gameState.applyCiv(houseTemplateString);
		let houseTemplate = gameState.getTemplate(houseTemplateName);

		let needed = 0;
		for (let entityReq of gameState.getPhaseEntityRequirements(this.phasing))
		{
			if (!houseTemplate.hasClass(entityReq.class))
				continue;

			let count = gameState.getOwnStructures().filter(API3.Filters.byClass(entityReq.class)).length;
			if (count < entityReq.count && this.buildManager.isUnbuildable(gameState, houseTemplateName))
			{
				KIARA.Logger.debug("no room to place a house ... try to be less restrictive");
				this.buildManager.setBuildable(houseTemplateName);
				this.requireHouses = true;
			}
			needed = Math.max(needed, entityReq.count - count);
		}

		let houseQueue = queues.house.plans;
		for (let i = 0; i < numPlanned; ++i)
			if (houseQueue[i].isGo(gameState))
				--needed;
			else if (needed > 0)
			{
				houseQueue[i].goRequirement = undefined;
				--needed;
			}
	}

	if (this.requireHouses)
	{
		let houseTemplate = gameState.getTemplate(gameState.applyCiv(houseTemplateString));
		if (!this.phasing || gameState.getPhaseEntityRequirements(this.phasing).every(req =>
			!houseTemplate.hasClass(req.class) || gameState.getOwnStructures().filter(API3.Filters.byClass(req.class)).length >= req.count))
			this.requireHouses = undefined;
	}

	// When population limit too tight
	//    - if no room to build, try to improve with technology
	//    - otherwise increase temporarily the priority of houses
	let house = gameState.applyCiv(houseTemplateString);
	let HouseNb = gameState.getOwnFoundations().filter(API3.Filters.byClass("House")).length;
	let popBonus = gameState.getTemplate(house).getPopulationBonus();
	let freeSlots = gameState.getPopulationLimit() + HouseNb*popBonus - this.getAccountedPopulation(gameState);
	let priority;
	if (freeSlots < 5)
	{
		if (this.buildManager.isUnbuildable(gameState, house))
		{
			KIARA.Logger.debug("no room to place a house ... try to improve with technology");
			this.researchManager.researchPopulationBonus(gameState, queues);
		}
		else
			priority = 2 * this.Config.priorities.house;
	}
	else
		priority = this.Config.priorities.house;

	if (priority && priority != gameState.ai.queueManager.getPriority("house"))
		gameState.ai.queueManager.changePriority("house", priority);
};

/** Checks the status of the territory expansion. If no new economic bases created, build some strategic ones. */
KIARA.HQ.prototype.checkBaseExpansion = function(gameState, queues)
{
	if (this.expanding)
		return;
	if (queues.civilCentre.hasQueuedUnits())
		return;
	// First build one cc if all have been destroyed
	if (this.numPotentialBases() == 0)
	{
		this.buildFirstBase(gameState);
		return;
	}
	// Then expand if we have not enough room available for buildings
	if (this.buildManager.numberMissingRoom(gameState) > 1)
	{
		KIARA.Logger.debug("try to build a new base because not enough room to build ");
		this.buildNewBase(gameState, queues);
		return;
	}
};

KIARA.HQ.prototype.buildNewBase = function(gameState, queues, resource)
{
	if (this.numPotentialBases() > 0 && this.currentPhase == 1 && !gameState.isResearching(gameState.getPhaseName(2)))
		return false;
	if (gameState.getOwnFoundations().filter(API3.Filters.byClass("CivCentre")).hasEntities() || queues.civilCentre.hasQueuedUnits())
		return false;

	let template;
	// We require at least one of this civ civCentre as they may allow specific units or techs
	let hasOwnCC = false;
	for (let ent of gameState.updatingGlobalCollection("allCCs", API3.Filters.byClass("CivCentre")).values())
	{
		if (ent.owner() != PlayerID || ent.templateName() != gameState.applyCiv(KIARA.Templates[KIARA.TemplateConstants.CC]))
			continue;
		hasOwnCC = true;
		break;
	}
	if (hasOwnCC && this.canBuild(gameState, KIARA.Templates[KIARA.TemplateConstants.Colony]))
		template = KIARA.Templates[KIARA.TemplateConstants.Colony];
	else if (this.canBuild(gameState, KIARA.Templates[KIARA.TemplateConstants.CC]))
		template = KIARA.Templates[KIARA.TemplateConstants.CC];
	else if (!hasOwnCC && this.canBuild(gameState, KIARA.Templates[KIARA.TemplateConstants.Colony]))
		template = KIARA.Templates[KIARA.TemplateConstants.Colony];
	else
		return false;

	// base "-1" means new base.
	KIARA.Logger.debug("new base " + gameState.applyCiv(template) + " planned with resource " + resource);
	queues.civilCentre.addPlan(new KIARA.ConstructionPlan(gameState, template, { "base": -1, "resource": resource }));
	this.expanding = true;
	return true;
};

/** Deals with building fortresses and towers along our border with enemies. */
KIARA.HQ.prototype.buildDefenses = function(gameState, queues)
{
	let numFortresses = gameState.getOwnEntitiesByClass("Fortress", true).length;
	if (this.currentPhase > 2 && !queues.defenseBuilding.hasQueuedUnits()) {
		// try to build fortresses
		if (!numFortresses && this.canBuild(gameState, KIARA.Templates[KIARA.TemplateConstants.Fortress]))
		{
			this.fortressStartTime = gameState.ai.elapsedTime;
			if (!numFortresses)
				gameState.ai.queueManager.changePriority("defenseBuilding", 3*this.Config.priorities.defenseBuilding);
			let plan = new KIARA.ConstructionPlan(gameState, KIARA.Templates[KIARA.TemplateConstants.Fortress]);
			plan.queueToReset = "defenseBuilding";
			queues.defenseBuilding.addPlan(plan);
			return;
		}
	}
	return;

	if (this.Config.Military.numSentryTowers && this.currentPhase < 2 && this.canBuild(gameState, "structures/{civ}/sentry_tower"))
	{
		let numTowers = gameState.getOwnEntitiesByClass("Tower", true).length;	// we count all towers, including wall towers
		let towerLapseTime = this.saveResource ? (1 + 0.5*numTowers) * this.towerLapseTime : this.towerLapseTime;
		if (numTowers < this.Config.Military.numSentryTowers && gameState.ai.elapsedTime > towerLapseTime + this.fortStartTime)
		{
			this.fortStartTime = gameState.ai.elapsedTime;
			queues.defenseBuilding.addPlan(new KIARA.ConstructionPlan(gameState, "structures/{civ}/sentry_tower"));
			return;
		}
	}

	if (this.currentPhase < 2)
		return;

	if (this.canBuild(gameState, "structures/{civ}/defense_tower"))
	{
		let numTowers = gameState.getOwnEntitiesByClass("StoneTower", true).length;
		let towerLapseTime = this.towerLapseTime;
		if ((!numTowers || gameState.ai.elapsedTime > (1 + 0.1*numTowers)*towerLapseTime + this.towerStartTime) &&
			numTowers < (2 + this.extraTowers) * this.numActiveBases()  &&
			gameState.getOwnFoundationsByClass("Tower").length < 2)
		{
			this.towerStartTime = gameState.ai.elapsedTime;
			let plan = new KIARA.ConstructionPlan(gameState, "structures/{civ}/defense_tower");
			if (numTowers < 5)
				plan.queueToReset = "defenseBuilding";
			queues.defenseBuilding.addPlan(plan);
		}
	}

	if (!this.saveResources && numFortresses < this.extraFortresses)
		return;

	if (!this.saveResources && (this.currentPhase > 2 || gameState.isResearching(gameState.getPhaseName(3))))
	{
		// Try to build fortresses.
		if (this.canBuild(gameState, KIARA.Templates[KIARA.TemplateConstants.Fortress]))
		{
			if ((!numFortresses || gameState.ai.elapsedTime > (1 + 0.10*numFortresses)*this.fortressLapseTime + this.fortressStartTime))
			{
				this.fortressStartTime = gameState.ai.elapsedTime;
				if (!numFortresses)
					gameState.ai.queueManager.changePriority("defenseBuilding", 2 * this.Config.priorities.defenseBuilding);
				let plan = new KIARA.ConstructionPlan(gameState, KIARA.Templates[KIARA.TemplateConstants.Fortress]);
				plan.queueToReset = "defenseBuilding";
				queues.defenseBuilding.addPlan(plan);
				return;
			}
		}
	}
};

KIARA.HQ.prototype.buildForge = function(gameState, queues)
{
	if (this.getAccountedPopulation(gameState) < this.Config.Military.popForForge ||
		queues.militaryBuilding.hasQueuedUnits() || gameState.getOwnEntitiesByClass("Forge", true).length)
		return;
	// Build a Market before the Forge.
	if (!gameState.getOwnEntitiesByClass("Market", true).hasEntities())
		return;

	if (this.canBuild(gameState, "structures/{civ}/forge"))
		queues.militaryBuilding.addPlan(new KIARA.ConstructionPlan(gameState, "structures/{civ}/forge"));
};

/**
 * Deals with constructing military buildings (barracks, stables…)
 * They are mostly defined by Config.js. This is unreliable since changes could be done easily.
 */
KIARA.HQ.prototype.constructTrainingBuildings = function(gameState, queues)
{
	if (this.saveResources && !this.canBarter || queues.militaryBuilding.hasQueuedUnits())
		return;

	let numBarracks = gameState.getOwnEntitiesByClass("Barracks", true).length;
	if (this.saveResources && numBarracks != 0)
		return;

	if (numBarracks && this.strategy != "attack")
		return;

	let barracksTemplate = this.canBuild(gameState, KIARA.Templates[KIARA.TemplateConstants.MeleeAndRanged]) ? KIARA.Templates[KIARA.TemplateConstants.MeleeAndRanged] : undefined;

	let rangeTemplate = this.canBuild(gameState, KIARA.Templates[KIARA.TemplateConstants.Ranged]) ? KIARA.Templates[KIARA.TemplateConstants.Ranged] : undefined;
	let numRanges = gameState.getOwnEntitiesByClass("Range", true).length;

	let stableTemplate = this.canBuild(gameState, KIARA.Templates[KIARA.TemplateConstants.Cavalry]) ? KIARA.Templates[KIARA.TemplateConstants.Cavalry] : undefined;
	let numStables = gameState.getOwnEntitiesByClass("Stable", true).length;

	if (this.getAccountedPopulation(gameState) > this.Config.Military.popForBarracks1 ||
	    this.phasing == 2 && gameState.getOwnStructures().filter(API3.Filters.byClass("Village")).length < 5)
	{
		let civ = gameState.getPlayerCiv();
		if (numStables == 0 && stableTemplate && civ == "brit")
		{
			this.strategy = KIARA.Strategy.DOG_RAID;
			this.attackManager.maxDogRaids = 1;
			queues.militaryBuilding.addPlan(new KIARA.ConstructionPlan(gameState, stableTemplate, { "militaryBase": true }));
		} else if (numStables == 0 && (this.strategy == KIARA.Strategy.EARLY_RAID || this.cavalryRush)) {
			queues.militaryBuilding.addPlan(new KIARA.ConstructionPlan(gameState, stableTemplate, { "militaryBase": true }));
			return;
		}
		// first barracks/range and stables.
		if (numBarracks + numRanges < 2)
		{
			let template = barracksTemplate || rangeTemplate;
			if (template)
			{
				gameState.ai.queueManager.changePriority("militaryBuilding", 2 * this.Config.priorities.militaryBuilding);
				let plan = new KIARA.ConstructionPlan(gameState, template, { "militaryBase": true });
				plan.queueToReset = "militaryBuilding";
				queues.militaryBuilding.addPlan(plan);
				return;
			}
		}
		if (numStables == 0 && stableTemplate)
		{
			queues.militaryBuilding.addPlan(new KIARA.ConstructionPlan(gameState, stableTemplate, { "militaryBase": true }));
			return;
		}

		// Second range/barracks and stables
		if (numBarracks + numRanges == 2 && this.getAccountedPopulation(gameState) > this.Config.Military.popForBarracks2)
		{
			let template = numBarracks == 0 ? (barracksTemplate || rangeTemplate) : (rangeTemplate || barracksTemplate);
			if (template)
			{
				queues.militaryBuilding.addPlan(new KIARA.ConstructionPlan(gameState, template, { "militaryBase": true }));
				return;
			}
		}
		if (numStables == 1 && stableTemplate && this.getAccountedPopulation(gameState) > this.Config.Military.popForBarracks2)
		{
			queues.militaryBuilding.addPlan(new KIARA.ConstructionPlan(gameState, stableTemplate, { "militaryBase": true }));
			return;
		}

		// Then 3rd barracks/range/stables if needed
		if (numBarracks + numRanges + numStables == 3 && this.getAccountedPopulation(gameState) > this.Config.Military.popForBarracks2 + 30)
		{
			let template = barracksTemplate || stableTemplate || rangeTemplate;
			if (template)
			{
				queues.militaryBuilding.addPlan(new KIARA.ConstructionPlan(gameState, template, { "militaryBase": true }));
				return;
			}
		}
	}

	if (this.saveResources)
		return;

	if (this.currentPhase < 3)
		return;

	let nArsenals = gameState.getOwnEntitiesByClass("Arsenal", true).length;
	if (this.canBuild(gameState, KIARA.Templates[KIARA.TemplateConstants.Siege]) && nArsenals < 3)
	{
		queues.militaryBuilding.addPlan(new KIARA.ConstructionPlan(gameState, KIARA.Templates[KIARA.TemplateConstants.Siege], { "militaryBase": true }));
		return;
	}

	if (this.canBuild(gameState, KIARA.Templates[KIARA.TemplateConstants.Elephants]) && !gameState.getOwnEntitiesByClass("ElephantStable", true).hasEntities())
	{
		queues.militaryBuilding.addPlan(new KIARA.ConstructionPlan(gameState, KIARA.Templates[KIARA.TemplateConstants.Elephants], { "militaryBase": true }));
		return;
	}

	if (this.getAccountedPopulation(gameState) < 80 || !this.bAdvanced.length)
		return;

	// Build advanced military buildings
	let nAdvanced = 0;
	for (let advanced of this.bAdvanced)
		nAdvanced += gameState.countEntitiesAndQueuedByType(advanced, true);

	if (!nAdvanced || nAdvanced < this.bAdvanced.length && this.getAccountedPopulation(gameState) > 110)
	{
		for (let advanced of this.bAdvanced)
		{
			if (gameState.countEntitiesAndQueuedByType(advanced, true) > 0 || !this.canBuild(gameState, advanced))
				continue;
			let template = gameState.getTemplate(advanced);
			if (!template)
				continue;
			let civ = gameState.getPlayerCiv();
			if (template.hasDefensiveFire() || template.trainableEntities(civ))
				queues.militaryBuilding.addPlan(new KIARA.ConstructionPlan(gameState, advanced, { "militaryBase": true }));
			else	// not a military building, but still use this queue
				queues.militaryBuilding.addPlan(new KIARA.ConstructionPlan(gameState, advanced));
			return;
		}
	}
};

/**
 *  Find base nearest to ennemies for military buildings.
 */
KIARA.HQ.prototype.findBestBaseForMilitary = function(gameState)
{
	let ccEnts = gameState.updatingGlobalCollection("allCCs", API3.Filters.byClass("CivCentre")).toEntityArray();
	let bestBase;
	let enemyFound = false;
	let distMin = Math.min();
	for (let cce of ccEnts)
	{
		if (gameState.isPlayerAlly(cce.owner()))
			continue;
		if (enemyFound && !gameState.isPlayerEnemy(cce.owner()))
			continue;
		let access = KIARA.getLandAccess(gameState, cce);
		let isEnemy = gameState.isPlayerEnemy(cce.owner());
		for (let cc of ccEnts)
		{
			if (cc.owner() != PlayerID)
				continue;
			if (KIARA.getLandAccess(gameState, cc) != access)
				continue;
			let dist = API3.SquareVectorDistance(cc.position(), cce.position());
			if (!enemyFound && isEnemy)
				enemyFound = true;
			else if (dist > distMin)
				continue;
			bestBase = cc.getMetadata(PlayerID, "base");
			distMin = dist;
		}
	}
	return bestBase;
};

/**
 * train with highest priority ranged infantry in the nearest civil center from a given set of positions
 * and garrison them there for defense
 */
KIARA.HQ.prototype.trainEmergencyUnits = function(gameState, positions)
{
	if (gameState.ai.queues.emergency.hasQueuedUnits())
		return false;

	let civ = gameState.getPlayerCiv();
	// find nearest base anchor
	let distcut = 20000;
	let nearestAnchor;
	let distmin;
	for (let pos of positions)
	{
		let access = gameState.ai.accessibility.getAccessValue(pos);
		// check nearest base anchor
		for (let base of this.baseManagers)
		{
			if (!base.anchor || !base.anchor.position())
				continue;
			if (KIARA.getLandAccess(gameState, base.anchor) != access)
				continue;
			if (!base.anchor.trainableEntities(civ))	// base still in construction
				continue;
			let queue = base.anchor._entity.trainingQueue;
			if (queue)
			{
				let time = 0;
				for (let item of queue)
					if (item.progress > 0 || item.metadata && item.metadata.garrisonType)
						time += item.timeRemaining;
				if (time/1000 > 5)
					continue;
			}
			let dist = API3.SquareVectorDistance(base.anchor.position(), pos);
			if (nearestAnchor && dist > distmin)
				continue;
			distmin = dist;
			nearestAnchor = base.anchor;
		}
	}
	if (!nearestAnchor || distmin > distcut)
		return false;

	// We will choose randomly ranged and melee units, except when garrisonHolder is full
	// in which case we prefer melee units
	let numGarrisoned = this.garrisonManager.numberOfGarrisonedUnits(nearestAnchor);
	if (nearestAnchor._entity.trainingQueue)
	{
		for (let item of nearestAnchor._entity.trainingQueue)
		{
			if (item.metadata && item.metadata.garrisonType)
				numGarrisoned += item.count;
			else if (!item.progress && (!item.metadata || !item.metadata.trainer))
				nearestAnchor.stopProduction(item.id);
		}
	}
	let autogarrison = numGarrisoned < nearestAnchor.garrisonMax() &&
	                   nearestAnchor.hitpoints() > nearestAnchor.garrisonEjectHealth() * nearestAnchor.maxHitpoints();
	let rangedWanted = randBool() && autogarrison;

	let total = gameState.getResources();
	let templateFound;
	let trainables = nearestAnchor.trainableEntities(civ);
	let garrisonArrowClasses = nearestAnchor.getGarrisonArrowClasses();
	for (let trainable of trainables)
	{
		if (gameState.isTemplateDisabled(trainable))
			continue;
		let template = gameState.getTemplate(trainable);
		if (!template || !template.hasClass("Infantry") || !template.hasClass("CitizenSoldier"))
			continue;
		if (autogarrison && !MatchesClassList(template.classes(), garrisonArrowClasses))
			continue;
		if (!total.canAfford(new API3.Resources(template.cost())))
			continue;
		templateFound = [trainable, template];
		if (template.hasClass("Ranged") == rangedWanted)
			break;
	}
	if (!templateFound)
		return false;

	// Check first if we can afford it without touching the other accounts
	// and if not, take some of other accounted resources
	// TODO sort the queues to be substracted
	let queueManager = gameState.ai.queueManager;
	let cost = new API3.Resources(templateFound[1].cost());
	queueManager.setAccounts(gameState, cost, "emergency");
	if (!queueManager.canAfford("emergency", cost))
	{
		for (let q in queueManager.queues)
		{
			if (q == "emergency")
				continue;
			queueManager.transferAccounts(cost, q, "emergency");
			if (queueManager.canAfford("emergency", cost))
				break;
		}
	}
	let metadata = { "role": "worker", "base": nearestAnchor.getMetadata(PlayerID, "base"), "plan": -1, "trainer": nearestAnchor.id() };
	if (autogarrison)
		metadata.garrisonType = "protection";
	gameState.ai.queues.emergency.addPlan(new KIARA.TrainingPlan(gameState, templateFound[0], metadata, 1, 1));
	return true;
};

KIARA.HQ.prototype.canBuild = function(gameState, structure)
{
	let type = gameState.applyCiv(structure);
	if (this.buildManager.isUnbuildable(gameState, type))
		return false;

	if (gameState.isTemplateDisabled(type))
	{
		this.buildManager.setUnbuildable(gameState, type, Infinity, "disabled");
		return false;
	}

	let template = gameState.getTemplate(type);
	if (!template)
	{
		this.buildManager.setUnbuildable(gameState, type, Infinity, "notemplate");
		return false;
	}

	if (!template.available(gameState))
	{
		this.buildManager.setUnbuildable(gameState, type, 30, "tech");
		return false;
	}

	if (!this.buildManager.hasBuilder(type))
	{
		this.buildManager.setUnbuildable(gameState, type, 120, "nobuilder");
		return false;
	}

	if (this.numActiveBases() < 1)
	{
		// if no base, check that we can build outside our territory
		let buildTerritories = template.buildTerritories();
		if (buildTerritories && (!buildTerritories.length || buildTerritories.length == 1 && buildTerritories[0] == "own"))
		{
			this.buildManager.setUnbuildable(gameState, type, 180, "room");
			return false;
		}
	}

	// build limits
	let limits = gameState.getEntityLimits();
	let category = template.buildCategory();
	if (category && limits[category] !== undefined && gameState.getEntityCounts()[category] >= limits[category])
	{
		this.buildManager.setUnbuildable(gameState, type, 90, "limit");
		return false;
	}

	return true;
};

KIARA.HQ.prototype.updateTerritories = function(gameState)
{
	const around = [ [-0.7, 0.7], [0, 1], [0.7, 0.7], [1, 0], [0.7, -0.7], [0, -1], [-0.7, -0.7], [-1, 0] ];
	let alliedVictory = gameState.getAlliedVictory();
	let passabilityMap = gameState.getPassabilityMap();
	let width = this.territoryMap.width;
	let cellSize = this.territoryMap.cellSize;
	let insideSmall = Math.round(45 / cellSize);
	let insideLarge = Math.round(80 / cellSize);	// should be about the range of towers
	let expansion = 0;

	for (let j = 0; j < this.territoryMap.length; ++j)
	{
		if (this.borderMap.map[j] & KIARA.outside_Mask)
			continue;
		if (this.borderMap.map[j] & KIARA.fullFrontier_Mask)
			this.borderMap.map[j] &= ~KIARA.fullFrontier_Mask;	// reset the frontier

		if (this.territoryMap.getOwnerIndex(j) != PlayerID)
		{
			// If this tile was already accounted, remove it
			if (this.basesMap.map[j] == 0)
				continue;
			let base = this.getBaseByID(this.basesMap.map[j]);
			if (base)
			{
				let index = base.territoryIndices.indexOf(j);
				if (index != -1)
					base.territoryIndices.splice(index, 1);
				else
					KIARA.Logger.debug(" problem in headquarters::updateTerritories for base " + this.basesMap.map[j]);
			}
			else
				KIARA.Logger.debug(" problem in headquarters::updateTerritories without base " + this.basesMap.map[j]);
			this.basesMap.map[j] = 0;
		}
		else
		{
			// Update the frontier
			let ix = j%width;
			let iz = Math.floor(j/width);
			let onFrontier = false;
			for (let a of around)
			{
				let jx = ix + Math.round(insideSmall*a[0]);
				if (jx < 0 || jx >= width)
					continue;
				let jz = iz + Math.round(insideSmall*a[1]);
				if (jz < 0 || jz >= width)
					continue;
				if (this.borderMap.map[jx+width*jz] & KIARA.outside_Mask)
					continue;
				let territoryOwner = this.territoryMap.getOwnerIndex(jx+width*jz);
				if (territoryOwner != PlayerID && !(alliedVictory && gameState.isPlayerAlly(territoryOwner)))
				{
					this.borderMap.map[j] |= KIARA.narrowFrontier_Mask;
					break;
				}
				jx = ix + Math.round(insideLarge*a[0]);
				if (jx < 0 || jx >= width)
					continue;
				jz = iz + Math.round(insideLarge*a[1]);
				if (jz < 0 || jz >= width)
					continue;
				if (this.borderMap.map[jx+width*jz] & KIARA.outside_Mask)
					continue;
				territoryOwner = this.territoryMap.getOwnerIndex(jx+width*jz);
				if (territoryOwner != PlayerID && !(alliedVictory && gameState.isPlayerAlly(territoryOwner)))
					onFrontier = true;
			}
			if (onFrontier && !(this.borderMap.map[j] & KIARA.narrowFrontier_Mask))
				this.borderMap.map[j] |= KIARA.largeFrontier_Mask;

			// If this tile was not already accounted, add it.
			if (this.basesMap.map[j] != 0)
				continue;
			let landPassable = false;
			let ind = API3.getMapIndices(j, this.territoryMap, passabilityMap);
			let access;
			for (let k of ind)
			{
				if (!this.landRegions[gameState.ai.accessibility.landPassMap[k]])
					continue;
				landPassable = true;
				access = gameState.ai.accessibility.landPassMap[k];
				break;
			}
			if (!landPassable)
				continue;
			let distmin = Math.min();
			let baseID;
			let pos = [cellSize * (j%width+0.5), cellSize * (Math.floor(j/width)+0.5)];
			for (let base of this.baseManagers)
			{
				if (!base.anchor || !base.anchor.position())
					continue;
				if (base.accessIndex != access)
					continue;
				let dist = API3.SquareVectorDistance(base.anchor.position(), pos);
				if (dist >= distmin)
					continue;
				distmin = dist;
				baseID = base.ID;
			}
			if (!baseID)
				continue;
			this.getBaseByID(baseID).territoryIndices.push(j);
			this.basesMap.map[j] = baseID;
			expansion++;
		}
	}

	if (!expansion)
		return;
	// We've increased our territory, so we may have some new room to build
	this.buildManager.resetMissingRoom(gameState);
	// And if sufficient expansion, check if building a new market would improve our present trade routes
	let cellArea = this.territoryMap.cellSize * this.territoryMap.cellSize;
	if (expansion * cellArea > 960)
		this.tradeManager.routeProspection = true;
};

/** Reassign territories when a base is going to be deleted */
KIARA.HQ.prototype.reassignTerritories = function(deletedBase)
{
	let cellSize = this.territoryMap.cellSize;
	let width = this.territoryMap.width;
	for (let j = 0; j < this.territoryMap.length; ++j)
	{
		if (this.basesMap.map[j] != deletedBase.ID)
			continue;
		if (this.territoryMap.getOwnerIndex(j) != PlayerID)
		{
			KIARA.Logger.debug("Kiara reassignTerritories: should never happen");
			this.basesMap.map[j] = 0;
			continue;
		}

		let distmin = Math.min();
		let baseID;
		let pos = [cellSize * (j%width+0.5), cellSize * (Math.floor(j/width)+0.5)];
		for (let base of this.baseManagers)
		{
			if (!base.anchor || !base.anchor.position())
				continue;
			if (base.accessIndex != deletedBase.accessIndex)
				continue;
			let dist = API3.SquareVectorDistance(base.anchor.position(), pos);
			if (dist >= distmin)
				continue;
			distmin = dist;
			baseID = base.ID;
		}
		if (baseID)
		{
			this.getBaseByID(baseID).territoryIndices.push(j);
			this.basesMap.map[j] = baseID;
		}
		else
			this.basesMap.map[j] = 0;
	}
};

/**
 * returns the base corresponding to baseID
 */
KIARA.HQ.prototype.getBaseByID = function(baseID)
{
	for (let base of this.baseManagers)
		if (base.ID == baseID)
			return base;

	return undefined;
};

/**
 * returns the number of bases with a cc
 * ActiveBases includes only those with a built cc
 * PotentialBases includes also those with a cc in construction
 */
KIARA.HQ.prototype.numActiveBases = function()
{
	if (!this.turnCache.base)
		this.updateBaseCache();
	return this.turnCache.base.active;
};

KIARA.HQ.prototype.numPotentialBases = function()
{
	if (!this.turnCache.base)
		this.updateBaseCache();
	return this.turnCache.base.potential;
};

KIARA.HQ.prototype.updateBaseCache = function()
{
	this.turnCache.base = { "active": 0, "potential": 0 };
	for (let base of this.baseManagers)
	{
		if (!base.anchor)
			continue;
		++this.turnCache.base.potential;
		if (base.anchor.foundationProgress() === undefined)
			++this.turnCache.base.active;
	}
};

KIARA.HQ.prototype.resetBaseCache = function()
{
	this.turnCache.base = undefined;
};

/**
 * Count gatherers returning resources in the number of gatherers of resourceSupplies
 * to prevent the AI always reassigning idle workers to these resourceSupplies (specially in naval maps).
 */
KIARA.HQ.prototype.assignGatherers = function()
{
	for (let base of this.baseManagers)
	{
		for (let worker of base.workers.values())
		{
			if (worker.unitAIState().split(".")[1] != "RETURNRESOURCE")
				continue;
			let orders = worker.unitAIOrderData();
			if (orders.length < 2 || !orders[1].target || orders[1].target != worker.getMetadata(PlayerID, "supply"))
				continue;
			this.AddTCGatherer(orders[1].target);
		}
	}
};

KIARA.HQ.prototype.isDangerousLocation = function(gameState, pos, radius)
{
	return this.isNearInvadingArmy(pos) || this.isUnderEnemyFire(gameState, pos, radius);
};

/** Check that the chosen position is not too near from an invading army */
KIARA.HQ.prototype.isNearInvadingArmy = function(pos)
{
	for (let army of this.defenseManager.armies)
		if (army.foePosition && API3.SquareVectorDistance(army.foePosition, pos) < 12000)
			return true;
	return false;
};

KIARA.HQ.prototype.isUnderEnemyFire = function(gameState, pos, radius = 0)
{
	if (!this.turnCache.firingStructures)
		this.turnCache.firingStructures = gameState.updatingCollection("diplo-FiringStructures", API3.Filters.hasDefensiveFire(), gameState.getEnemyStructures());
	for (let ent of this.turnCache.firingStructures.values())
	{
		let ranged = ent.attackRange("Ranged");
		let range = radius + ranged.max + ranged.elevationBonus;
		if (API3.SquareVectorDistance(ent.position(), pos) < range*range)
			return true;
	}
	return false;
};

/** Compute the capture strength of all units attacking a capturable target */
KIARA.HQ.prototype.updateCaptureStrength = function(gameState)
{
	this.capturableTargets.clear();
	for (let ent of gameState.getOwnUnits().values())
	{
		if (!ent.canCapture())
			continue;
		let state = ent.unitAIState();
		if (!state || !state.split(".")[1] || state.split(".")[1] != "COMBAT")
			continue;
		let orderData = ent.unitAIOrderData();
		if (!orderData || !orderData.length || !orderData[0].target)
			continue;
		let targetId = orderData[0].target;
		let target = gameState.getEntityById(targetId);
		if (!target || !target.isCapturable() || !ent.canCapture(target))
			continue;
		if (!this.capturableTargets.has(targetId))
			this.capturableTargets.set(targetId, {
				"strength": ent.captureStrength() * KIARA.getAttackBonus(ent, target, "Capture"),
				"ents": new Set([ent.id()])
			});
		else
		{
			let capturableTarget = this.capturableTargets.get(target.id());
			capturableTarget.strength += ent.captureStrength() * KIARA.getAttackBonus(ent, target, "Capture");
			capturableTarget.ents.add(ent.id());
		}
	}

	for (let [targetId, capturableTarget] of this.capturableTargets)
	{
		let target = gameState.getEntityById(targetId);
		let allowCapture;
		for (let entId of capturableTarget.ents)
		{
			let ent = gameState.getEntityById(entId);
			if (allowCapture === undefined)
				allowCapture = KIARA.allowCapture(gameState, ent, target);
			let orderData = ent.unitAIOrderData();
			if (!orderData || !orderData.length || !orderData[0].attackType)
				continue;
			if ((orderData[0].attackType == "Capture") !== allowCapture)
				ent.attack(targetId, allowCapture);
		}
	}

	this.capturableTargetsTime = gameState.ai.elapsedTime;
};

/** Some functions that register that we assigned a gatherer to a resource this turn */

/** add a gatherer to the turn cache for this supply. */
KIARA.HQ.prototype.AddTCGatherer = function(supplyID)
{
	if (this.turnCache.resourceGatherer && this.turnCache.resourceGatherer[supplyID] !== undefined)
		++this.turnCache.resourceGatherer[supplyID];
	else
	{
		if (!this.turnCache.resourceGatherer)
			this.turnCache.resourceGatherer = {};
		this.turnCache.resourceGatherer[supplyID] = 1;
	}
};

/** remove a gatherer to the turn cache for this supply. */
KIARA.HQ.prototype.RemoveTCGatherer = function(supplyID)
{
	if (this.turnCache.resourceGatherer && this.turnCache.resourceGatherer[supplyID])
		--this.turnCache.resourceGatherer[supplyID];
	else
	{
		if (!this.turnCache.resourceGatherer)
			this.turnCache.resourceGatherer = {};
		this.turnCache.resourceGatherer[supplyID] = -1;
	}
};

KIARA.HQ.prototype.GetTCGatherer = function(supplyID)
{
	if (this.turnCache.resourceGatherer && this.turnCache.resourceGatherer[supplyID])
		return this.turnCache.resourceGatherer[supplyID];

	return 0;
};

/** The next two are to register that we assigned a gatherer to a resource this turn. */
KIARA.HQ.prototype.AddTCResGatherer = function(resource, rates)
{
	if (this.turnCache["resourceGatherer-" + resource])
		++this.turnCache["resourceGatherer-" + resource];
	else
		this.turnCache["resourceGatherer-" + resource] = rates[resource] || 1;

	if (this.turnCache.currentRates)
		this.turnCache.currentRates[resource] += rates[resource] || 0.5;
};

KIARA.HQ.prototype.GetTCResGatherer = function(resource)
{
	if (this.turnCache["resourceGatherer-" + resource])
		return this.turnCache["resourceGatherer-" + resource];

	return 0;
};

/**
 * flag a resource as exhausted
 */
KIARA.HQ.prototype.isResourceExhausted = function(resource)
{
	if (this.turnCache["exhausted-" + resource] == undefined)
		this.turnCache["exhausted-" + resource] = this.baseManagers.every(base =>
			!base.dropsiteSupplies[resource].nearby.length &&
			!base.dropsiteSupplies[resource].medium.length &&
			!base.dropsiteSupplies[resource].faraway.length);

	return this.turnCache["exhausted-" + resource];
};

/**
 * Check if a structure in blinking territory should/can be defended (currently if it has some attacking armies around)
 */
KIARA.HQ.prototype.isDefendable = function(ent)
{
	if (!this.turnCache.numAround)
		this.turnCache.numAround = {};
	if (this.turnCache.numAround[ent.id()] === undefined)
		this.turnCache.numAround[ent.id()] = this.attackManager.numAttackingUnitsAround(ent.position(), 130);
	return +this.turnCache.numAround[ent.id()] > 8;
};

/**
 * Get the number of population already accounted for
 */
KIARA.HQ.prototype.getAccountedPopulation = function(gameState)
{
	if (this.turnCache.accountedPopulation == undefined)
	{
		let pop = gameState.getPopulation();
		for (let ent of gameState.getOwnTrainingFacilities().values())
		{
			for (let item of ent.trainingQueue())
			{
				if (!item.unitTemplate)
					continue;
				let unitPop = gameState.getTemplate(item.unitTemplate).get("Cost/Population");
				if (unitPop)
					pop += item.count * unitPop;
			}
		}
		this.turnCache.accountedPopulation = pop;
	}
	return this.turnCache.accountedPopulation;
};

/**
 * Get the number of workers already accounted for
 */
KIARA.HQ.prototype.getAccountedWorkers = function(gameState)
{
	if (this.turnCache.accountedWorkers == undefined)
	{
		let workers = gameState.getOwnEntitiesByRole("worker", true).length;
		for (let ent of gameState.getOwnTrainingFacilities().values())
		{
			for (let item of ent.trainingQueue())
			{
				if (!item.metadata || !item.metadata.role || item.metadata.role != "worker")
					continue;
				workers += item.count;
			}
		}
		this.turnCache.accountedWorkers = workers;
	}
	return this.turnCache.accountedWorkers;
};

KIARA.HQ.prototype.getDropsiteClass = function(resource)
{
	if (resource == "food")
		return "DropsiteFood";
	if (resource == "wood")
		return "DropsiteWood";
	if (resource == "stone")
		return "DropsiteStone";
	if (resource == "metal")
		return "DropsiteMetal";
	return "Storehouse";
}

/**
 * Some functions are run every turn
 * Others once in a while
 */
KIARA.HQ.prototype.update = function(gameState, queues, events)
{
	Engine.ProfileStart("Headquarters update");
	this.turnCache = {};
	this.territoryMap = KIARA.createTerritoryMap(gameState);
	this.canBarter = gameState.getOwnEntitiesByClass("Market", true).filter(API3.Filters.isBuilt()).hasEntities();
	// TODO find a better way to update
	if (this.currentPhase != gameState.currentPhase())
	{
		KIARA.Logger.trace(" civ " + gameState.getPlayerCiv() + " has phasedUp from " + this.currentPhase +
			          " to " + gameState.currentPhase() + " at time " + gameState.ai.elapsedTime +
				  " phasing " + this.phasing);
		this.currentPhase = gameState.currentPhase();

		// In principle, this.phasing should be already reset to 0 when starting the research
		// but this does not work in case of an autoResearch tech
		if (this.phasing)
			this.phasing = 0;
	}


	let pop = gameState.getPopulation();
	// Some units were killed, reset wantPop
	if (this.lastPop && pop < this.lastPop)
		this.wantPop = 0;
	this.lastPop = pop;
	if (this.lastPopGrow < pop)
		this.lastPopGrow = pop;

	let popCaped = gameState.getPopulationMax() - pop < 5;

	this.checkEvents(gameState, events);
	this.navalManager.checkEvents(gameState, queues, events);

	if (this.phasing)
		this.checkPhaseRequirements(gameState, queues);
	if (this.researchManager.checkPhase(gameState, queues))
			this.phasingQued = true;

	// Handle strategy switching
	KIARA.Logger.debug(this.strategy);
	if (this.strategy == KIARA.Strategy.RECOVER) {
		if (pop > 200)
			this.strategy = KIARA.Strategy.ATTACK;
	}
	else if (pop < 200 && pop < this.lastPopGrow && this.lastPopGrow > 200) {
		this.strategy = KIARA.Strategy.RECOVER;
	}
	else if (pop > 100) {
		this.strategy = KIARA.Strategy.ATTACK;
	} else if (this.cavalryRush && pop > 20) {
		this.strategy = KIARA.Strategy.EARLY_RAID;
		this.attackManager.maxRaids = 2;
		this.cavalryRush = false;
	}
	KIARA.Logger.debug("new strategy = " + this.strategy);

	if (
			!gameState.getOwnEntitiesByClass("Farmstead", true).length && 
			!queues.dropsites.hasQueuedUnitsWithClass("Farmstead") &&
			!gameState.getOwnFoundationsByClass("Farmstead", true).length
	)
		this.buildFoodSupply(gameState, queues, "dropsites", "food");

	if (
			!gameState.getOwnEntitiesByClass("Storehouse", true).length &&
			!queues.dropsites.hasQueuedUnitsWithClass("Storehouse") &&
			!gameState.getOwnFoundationsByClass("Storehouse", true).length
	) {
	//	KIARA.Logger.debug("wanna another dropsite");
		this.buildDropsite(gameState, queues, "dropsites", "any");
	}

//	KIARA.Logger.debug(uneval(this.needDropsite));

	let nFields = gameState.getOwnEntitiesByClass("Field", true).length  + gameState.getOwnFoundationsByClass("Field").length;
	let wantFarm = this.isResourceExhausted("food") || (nFields < 8);

	let quedFields = queues.economicBuilding.hasQueuedUnitsWithClass("Field", true) ||
		gameState.getOwnFoundationsByClass("Field", true).length;
	if (wantFarm && !quedFields)
		this.buildField(gameState, queues);

	let needToExpand = false;
	for (let res of Resources.GetCodes()) {
		let cl = this.getDropsiteClass(res);
		if (this.needDropsite[res]) {
	//		KIARA.Logger.debug("need Dropsite for " + res + " : " + cl);
		}
		else {
			continue;
		}
		if ( 
			!queues.dropsites.hasQueuedUnitsWithClass(cl, true) &&
			!gameState.getOwnFoundationsByClass(cl, true).length
		) {
			KIARA.Logger.debug("building for : " + res + " : " + cl);
			let dq = this.buildDropsite(gameState, queues, "dropsites", res);
			if (!dq && res == "food") {
				if (nFields < 2*this.currentPhase && !quedFields)
					this.buildField(gameState, queues);
			}
			if (
				!dq &&
				this.isResourceExhausted(res)
			) {
				needToExpand = res;
				KIARA.Logger.debug("need expand " + res);
			}
		} else {
			KIARA.Logger.debug("has qued or foundation for : " + res + " : " + cl);
		}
	}


	if (this.numActiveBases() > 0)
	{
		if (gameState.ai.playedTurn % 4 == 0)
			this.trainMoreWorkers(gameState, queues);

		if (gameState.ai.playedTurn % 4 == 1)
			this.buildMoreHouses(gameState, queues);

		if (this.needCorral && gameState.ai.playedTurn % 4 == 3)
			this.manageCorral(gameState, queues);

	if (!queues.minorTech.hasQueuedUnits() && this.strategy != "recover"/* && gameState.ai.playedTurn % 5 == 1*/)
			this.researchManager.update(gameState, queues);
	}

	if (this.currentPhase > 1 && !this.expanding && this.canExpand)
		this.checkBaseExpansion(gameState, queues);

	if (this.currentPhase > 1 && gameState.ai.playedTurn % 3 == 0)
	{
		if (gameState.ai.HQ.canBuild(gameState, KIARA.Templates[KIARA.TemplateConstants.Corral]))
			this.manageCorral(gameState, queues);

		if (!this.canBarter)
			this.buildMarket(gameState, queues);

		if (!this.saveResources)
		{
			if (this.currentPhase > 1) {
				if (!gameState.getOwnEntitiesByClass("Forge", true).hasEntities() && gameState.ai.HQ.canBuild(gameState,"structures/{civ}/forge"))
					this.buildForge(gameState, queues);
				this.buildTemple(gameState, queues);
			}
		}

		if (gameState.ai.playedTurn % 30 == 0 &&
		    gameState.getPopulation() > 0.9 * gameState.getPopulationMax())
			this.buildWonder(gameState, queues, false);
	}

	this.tradeManager.update(gameState, events, queues);

	this.garrisonManager.update(gameState, events);
	this.defenseManager.update(gameState, events);

	if (gameState.ai.playedTurn % 3 == 0)
	{
		this.constructTrainingBuildings(gameState, queues);
		this.buildDefenses(gameState, queues);
	}

	this.assignGatherers();
	let nbBases = this.baseManagers.length;
	let activeBase;	// We will loop only on 1 active base per turn
	do
	{
		this.currentBase %= this.baseManagers.length;
		activeBase = this.baseManagers[this.currentBase++].update(gameState, queues, events);
		--nbBases;
		// TODO what to do with this.reassignTerritories(this.baseManagers[this.currentBase]);
	}
	while (!activeBase && nbBases != 0);

	this.navalManager.update(gameState, queues, events);

	if (this.numActiveBases() > 0 || !this.canBuildUnits)
		this.attackManager.update(gameState, queues, events);

	this.diplomacyManager.update(gameState, events);

	this.victoryManager.update(gameState, events, queues);

	// We update the capture strength at the end as it can change attack orders
	if (gameState.ai.elapsedTime - this.capturableTargetsTime > 3)
		this.updateCaptureStrength(gameState);

	Engine.ProfileStop();
};

KIARA.HQ.prototype.Serialize = function()
{
	let properties = {
		"rangedSwitcher": this.rangedSwitcher,
		"cavSwitcher": this.cavSwitcher,
		"phasing": this.phasing,
		"currentBase": this.currentBase,
		"lastFailedGather": this.lastFailedGather,
		"firstBaseConfig": this.firstBaseConfig,
		"supportRatio": this.supportRatio,
		"targetNumWorkers": this.targetNumWorkers,
		"fortStartTime": this.fortStartTime,
		"towerStartTime": this.towerStartTime,
		"fortressStartTime": this.fortressStartTime,
		"bAdvanced": this.bAdvanced,
		"saveResources": this.saveResources,
		"saveSpace": this.saveSpace,
		"needCorral": this.needCorral,
		"needFarm": this.needFarm,
		"needFish": this.needFish,
		"maxFields": this.maxFields,
		"canExpand": this.canExpand,
		"canBuildUnits": this.canBuildUnits,
		"navalMap": this.navalMap,
		"landRegions": this.landRegions,
		"navalRegions": this.navalRegions,
		"decayingStructures": this.decayingStructures,
		"capturableTargets": this.capturableTargets,
		"capturableTargetsTime": this.capturableTargetsTime
	};

	let baseManagers = [];
	for (let base of this.baseManagers)
		baseManagers.push(base.Serialize());

	if (KIARA.Logger.isSerialization())
	{
		KIARA.Logger.debug(" HQ serialization ---------------------");
		KIARA.Logger.debug(" properties " + uneval(properties));
		KIARA.Logger.debug(" baseManagers " + uneval(baseManagers));
		KIARA.Logger.debug(" attackManager " + uneval(this.attackManager.Serialize()));
		KIARA.Logger.debug(" buildManager " + uneval(this.buildManager.Serialize()));
		KIARA.Logger.debug(" defenseManager " + uneval(this.defenseManager.Serialize()));
		KIARA.Logger.debug(" tradeManager " + uneval(this.tradeManager.Serialize()));
		KIARA.Logger.debug(" navalManager " + uneval(this.navalManager.Serialize()));
		KIARA.Logger.debug(" researchManager " + uneval(this.researchManager.Serialize()));
		KIARA.Logger.debug(" diplomacyManager " + uneval(this.diplomacyManager.Serialize()));
		KIARA.Logger.debug(" garrisonManager " + uneval(this.garrisonManager.Serialize()));
		KIARA.Logger.debug(" victoryManager " + uneval(this.victoryManager.Serialize()));
	}

	return {
		"properties": properties,

		"baseManagers": baseManagers,
		"attackManager": this.attackManager.Serialize(),
		"buildManager": this.buildManager.Serialize(),
		"defenseManager": this.defenseManager.Serialize(),
		"tradeManager": this.tradeManager.Serialize(),
		"navalManager": this.navalManager.Serialize(),
		"researchManager": this.researchManager.Serialize(),
		"diplomacyManager": this.diplomacyManager.Serialize(),
		"garrisonManager": this.garrisonManager.Serialize(),
		"victoryManager": this.victoryManager.Serialize(),
	};
};

KIARA.HQ.prototype.Deserialize = function(gameState, data)
{
	for (let key in data.properties)
		this[key] = data.properties[key];

	this.baseManagers = [];
	for (let base of data.baseManagers)
	{
		// the first call to deserialize set the ID base needed by entitycollections
		let newbase = new KIARA.BaseManager(gameState, this.Config);
		newbase.Deserialize(gameState, base);
		newbase.init(gameState);
		newbase.Deserialize(gameState, base);
		this.baseManagers.push(newbase);
	}

	this.navalManager = new KIARA.NavalManager(this.Config);
	this.navalManager.init(gameState, true);
	this.navalManager.Deserialize(gameState, data.navalManager);

	this.attackManager = new KIARA.AttackManager(this.Config);
	this.attackManager.Deserialize(gameState, data.attackManager);
	this.attackManager.init(gameState);
	this.attackManager.Deserialize(gameState, data.attackManager);

	this.buildManager = new KIARA.BuildManager();
	this.buildManager.Deserialize(data.buildManager);

	this.defenseManager = new KIARA.DefenseManager(this.Config);
	this.defenseManager.Deserialize(gameState, data.defenseManager);

	this.tradeManager = new KIARA.TradeManager(this.Config);
	this.tradeManager.init(gameState);
	this.tradeManager.Deserialize(gameState, data.tradeManager);

	this.researchManager = new KIARA.ResearchManager(this.Config);
	this.researchManager.Deserialize(data.researchManager);

	this.diplomacyManager = new KIARA.DiplomacyManager(this.Config);
	this.diplomacyManager.Deserialize(data.diplomacyManager);

	this.garrisonManager = new KIARA.GarrisonManager(this.Config);
	this.garrisonManager.Deserialize(data.garrisonManager);

	this.victoryManager = new KIARA.VictoryManager(this.Config);
	this.victoryManager.Deserialize(data.victoryManager);
};
