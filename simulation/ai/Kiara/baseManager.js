/**
 * Base Manager
 * Handles lower level economic stuffs.
 * Some tasks:
 *  -tasking workers: gathering/hunting/building/repairing?/scouting/plans.
 *  -giving feedback/estimates on GR
 *  -achieving building stuff plans (scouting/getting ressource/building) or other long-staying plans.
 *  -getting good spots for dropsites
 *  -managing dropsite use in the base
 *  -updating whatever needs updating, keeping track of stuffs (rebuilding needs…)
 */

KIARA.BaseManager = function(gameState, Config)
{
	this.Config = Config;
	this.ID = gameState.ai.uniqueIDs.bases++;

	// anchor building: seen as the main building of the base. Needs to have territorial influence
	this.anchor = undefined;
	this.anchorId = undefined;
	this.accessIndex = undefined;

	this.maxDistResourceSquare = 20*20;

	this.constructing = false;
	// Defenders to train in this cc when its construction is finished
	this.neededDefenders = this.Config.difficulty > KIARA.Difficulty.EASY ? 3 + 2*(this.Config.difficulty - 3) : 0;

	// vector for iterating, to check one use the HQ map.
	this.territoryIndices = [];

	this.timeNextIdleCheck = 0;

	this.needDropsite = {};
	for (let res of Resources.GetCodes())
		this.needDropsite[res] = false;
};

KIARA.BaseManager.prototype.init = function(gameState, state)
{
	if (state == "unconstructed")
		this.constructing = true;
	else if (state != "captured")
		this.neededDefenders = 0;
	this.workerObject = new KIARA.Worker(this);
	// entitycollections
	this.units = gameState.getOwnUnits().filter(API3.Filters.byMetadata(PlayerID, "base", this.ID));
	this.workers = this.units.filter(API3.Filters.byMetadata(PlayerID, "role", "worker"));
	this.buildings = gameState.getOwnStructures().filter(API3.Filters.byMetadata(PlayerID, "base", this.ID));
	this.mobileDropsites = this.units.filter(API3.Filters.isDropsite());

	this.units.registerUpdates();
	this.workers.registerUpdates();
	this.buildings.registerUpdates();
	this.mobileDropsites.registerUpdates();

	// array of entity IDs, with each being
	this.dropsites = {};
	this.dropsiteSupplies = {};
	this.gatherers = {};
	for (let res of Resources.GetCodes())
	{
		this.dropsiteSupplies[res] = { "nearby": [], "medium": [], "faraway": [] };
		this.gatherers[res] = { "nextCheck": 0, "used": 0, "lost": 0 };
	}
	this.dropsiteSupplies["hunt"] = { "nearby": [], "medium": [], "faraway": [] };
};

KIARA.BaseManager.prototype.reset = function(gameState, state)
{
	if (state == "unconstructed")
		this.constructing = true;
	else
		this.constructing = false;

	if (state != "captured" || this.Config.difficulty < KIARA.Difficulty.MEDIUM)
		this.neededDefenders = 0;
	else
		this.neededDefenders = 3 + 2 * (this.Config.difficulty - 3);
};

KIARA.BaseManager.prototype.assignEntity = function(gameState, ent)
{
	ent.setMetadata(PlayerID, "base", this.ID);
	this.units.updateEnt(ent);
	this.workers.updateEnt(ent);
	this.buildings.updateEnt(ent);
	if (ent.resourceDropsiteTypes() && !ent.hasClass("Unit"))
		this.assignResourceToDropsite(gameState, ent);
};

KIARA.BaseManager.prototype.setAnchor = function(gameState, anchorEntity)
{
	if (!anchorEntity.hasClass("CivCentre"))
		KIARA.Logger.error("Error: Kiara base " + this.ID + " has been assigned " + ent.templateName() + " as anchor.");
	else
	{
		this.anchor = anchorEntity;
		this.anchorId = anchorEntity.id();
		this.anchor.setMetadata(PlayerID, "baseAnchor", true);
		gameState.ai.HQ.resetBaseCache();
	}
	anchorEntity.setMetadata(PlayerID, "base", this.ID);
	this.buildings.updateEnt(anchorEntity);
	this.accessIndex = KIARA.getLandAccess(gameState, anchorEntity);
	return true;
};

/* we lost our anchor. Let's reassign our units and buildings */
KIARA.BaseManager.prototype.anchorLost = function(gameState, ent)
{
	this.anchor = undefined;
	this.anchorId = undefined;
	this.neededDefenders = 0;
	gameState.ai.HQ.resetBaseCache();
};

/** Set a building of an anchorless base */
KIARA.BaseManager.prototype.setAnchorlessEntity = function(gameState, ent)
{
	if (!this.buildings.hasEntities())
	{
		if (!KIARA.getBuiltEntity(gameState, ent).resourceDropsiteTypes())
			KIARA.Logger.error("Error: Kiara base " + this.ID + " has been assigned " + ent.templateName() + " as origin.");
		this.accessIndex = KIARA.getLandAccess(gameState, ent);
	}
	else if (this.accessIndex != KIARA.getLandAccess(gameState, ent))
		KIARA.Logger.error(" Error: Kiara base " + this.ID + " with access " + this.accessIndex +
		          " has been assigned " + ent.templateName() + " with access" + KIARA.getLandAccess(gameState, ent));

	ent.setMetadata(PlayerID, "base", this.ID);
	this.buildings.updateEnt(ent);
	return true;
};

KIARA.BaseManager.prototype.checkGatherers = function(gameState)
{
	for (let ent of this.workers.values())
		this.workerObject.checkNearerResources(gameState, ent);
}

/**
 * Assign the resources around the dropsites of this basis in three areas according to distance, and sort them in each area.
 * Moving resources (animals) and buildable resources (fields) are treated elsewhere.
 */
KIARA.BaseManager.prototype.assignResourceToDropsite = function(gameState, dropsite)
{
	if (this.dropsites[dropsite.id()])
	{
		KIARA.Logger.error("assignResourceToDropsite: dropsite already in the list. Should never happen");
		return;
	}

	let accessIndex = this.accessIndex;
	let dropsitePos = dropsite.position();
	let dropsiteId = dropsite.id();
	let radius = dropsite.obstructionRadius().max;
	this.dropsites[dropsiteId] = true;

	if (this.ID == gameState.ai.HQ.baseManagers[0].ID)
		accessIndex = KIARA.getLandAccess(gameState, dropsite);

	let maxDistResourceSquare = this.maxDistResourceSquare;
	let mdrs = maxDistResourceSquare;

	let dc = {
		"food": 1,
		"wood": 2,
		"stone": 1,
		"metal": 1,
		"hunt": 1
	};

	let ddc = {
		"food": 1,
		"wood": 1,
		"stone": 1,
		"metal": 1,
		"hunt": 3
	}

	let debug = KIARA.Logger.isDebug();
	for (let type of dropsite.resourceDropsiteTypes())
	{
		let resources = gameState.getResourceSupplies(type);
		if (!resources.length)
			continue;

		let nearby = this.dropsiteSupplies[type].nearby;
		let medium = this.dropsiteSupplies[type].medium;
		let faraway = this.dropsiteSupplies[type].faraway;

		let nearbyHunt = this.dropsiteSupplies["hunt"].nearby;
		let mediumHunt = this.dropsiteSupplies["hunt"].medium;
		let farawayHunt = this.dropsiteSupplies["hunt"].faraway;

		resources.forEach(function(supply)
		{
			let ss = type;
			if (!supply.position())
				return;
			if (supply.hasClass("Animal"))    // moving resources are treated differently
				ss = "hunt";
			if (supply.hasClass("Field"))     // fields are treated separately
				return;
			let res = supply.resourceSupplyType().generic;
			// quick accessibility check
			if (KIARA.getLandAccess(gameState, supply) != accessIndex)
				return;

			let dist = API3.SquareVectorDistance(supply.position(), dropsitePos) - (radius*radius/4);
			if (dist < maxDistResourceSquare * 81 * ddc[ss])
			{
				let sd = supply.getMetadata(PlayerID, "dist");
				if (Math.abs(dropsitePos[2] - supply.position()[2]) > 10) {
					if (!sd)
						supply.setMetadata(PlayerID, "dist", "faraway");
					if (ss == "hunt")
						farawayHunt.push({"ent": supply, "id": supply.id()});
					else
						faraway.push({ "dropsite": dropsiteId, "id": supply.id(), "ent": supply, "dist": dist });
				}
				else if (dist < maxDistResourceSquare * 3 * dc[ss]){
					supply.setMetadata(PlayerID, "dist", "nearby");
					if (ss == "hunt")
						nearbyHunt.push({"ent": supply, "id": supply.id()});
					else
						nearby.push({ "dropsite": dropsiteId, "id": supply.id(), "ent": supply, "dist": dist });
				}
				else if (dist < maxDistResourceSquare * 6 * dc[ss]) {
					if (sd != "nearby")
						supply.setMetadata(PlayerID, "dist", "medium");

					if (ss == "hunt")
						mediumHunt.push({"ent": supply, "id": supply.id()});
					else
						medium.push({ "dropsite": dropsiteId, "id": supply.id(), "ent": supply, "dist": dist });
				}
				else {
					if (!sd)
						supply.setMetadata(PlayerID, "dist", "faraway");

					if (ss == "hunt")
						farawayHunt.push({"ent": supply, "id": supply.id()});
					else
						faraway.push({ "dropsite": dropsiteId, "id": supply.id(), "ent": supply, "dist": dist });
				}
			}
		});

		nearby.sort((r1, r2) => r1.dist - r2.dist);
		medium.sort((r1, r2) => r1.dist - r2.dist);
		faraway.sort((r1, r2) => r1.dist - r2.dist);

		if (debug)
		{
			faraway.forEach(function(res){
				Engine.PostCommand(PlayerID,{"type": "set-shading-color", "entities": [res.ent.id()], "rgb": [2,0,0]});
			});
			medium.forEach(function(res){
				Engine.PostCommand(PlayerID,{"type": "set-shading-color", "entities": [res.ent.id()], "rgb": [0,2,0]});
			});
			nearby.forEach(function(res){
				Engine.PostCommand(PlayerID,{"type": "set-shading-color", "entities": [res.ent.id()], "rgb": [0,0,2]});
			});
		}

		if (nearby.length)
			this.signalNoNeedSupply(gameState, type);
		else if (dropsite.getMetadata(PlayerID, "type") == type)
			this.signalNoSupply(gameState, type, 10, true);
	}

	if (debug) {
		this.dropsiteSupplies["hunt"].faraway.forEach(function(res){
			Engine.PostCommand(PlayerID,{"type": "set-shading-color", "entities": [res.ent.id()], "rgb": [0,2,2]});
		});
		this.dropsiteSupplies["hunt"].medium.forEach(function(res){
			Engine.PostCommand(PlayerID,{"type": "set-shading-color", "entities": [res.ent.id()], "rgb": [0,2,2]});
		});
		this.dropsiteSupplies["hunt"].nearby.forEach(function(res){
			Engine.PostCommand(PlayerID,{"type": "set-shading-color", "entities": [res.ent.id()], "rgb": [0,2,2]});
		});
	}

	this.checkGatherers(gameState);

	// Allows all allies to use this dropsite except if base anchor to be sure to keep
	// a minimum of resources for this base
	Engine.PostCommand(PlayerID, {
		"type": "set-dropsite-sharing",
		"entities": [dropsiteId],
		"shared": dropsiteId != this.anchorId
	});
};

// completely remove the dropsite resources from our list.
KIARA.BaseManager.prototype.removeDropsite = function(gameState, ent)
{
	if (!ent.id())
		return;

	let removeSupply = function(entId, supply){
		for (let i = 0; i < supply.length; ++i)
		{
			// exhausted resource, remove it from this list
			if (!supply[i].ent || !gameState.getEntityById(supply[i].id))
				supply.splice(i--, 1);
			// resource assigned to the removed dropsite, remove it
			else if (supply[i].dropsite == entId)
				supply.splice(i--, 1);
		}
	};

	for (let type in this.dropsiteSupplies)
	{
		removeSupply(ent.id(), this.dropsiteSupplies[type].nearby);
		removeSupply(ent.id(), this.dropsiteSupplies[type].medium);
		removeSupply(ent.id(), this.dropsiteSupplies[type].faraway);
	}

	this.dropsites[ent.id()] = undefined;
};

KIARA.BaseManager.prototype.findBestFarmsteadLocation = function(gameState, resource)
{
	let template = gameState.getTemplate(gameState.applyCiv(KIARA.Templates[KIARA.TemplateConstants.Farmstead]));
	let halfSize = 0;
	if (template.get("Footprint/Square"))
		halfSize = Math.max(+template.get("Footprint/Square/@depth"), +template.get("Footprint/Square/@width")) / 2;
	else if (template.get("Footprint/Circle"))
		halfSize = +template.get("Footprint/Circle/@radius");

//	let ccEnts = gameState.getOwnStructures().filter(API3.Filters.byClass("CivCentre")).toEntityArray();
	let dpEnts = gameState.getOwnStructures().filter(API3.Filters.byClasses(["Farmstead", "Dock"])).toEntityArray();

	let obstructions = KIARA.createObstructionMap(gameState, this.accessIndex, template);

	let bestIdx;
	let bestVal = 0;
	let radius = Math.ceil(template.obstructionRadius().max / obstructions.cellSize);

	let territoryMap = gameState.ai.HQ.territoryMap;
	let width = territoryMap.width;
	let cellSize = territoryMap.cellSize;

	let resMap = gameState.sharedScript.resourceMaps[resource];
	if (!resMap) {
		KIARA.Logger.error("resource map is undefined for " + resource);
		resource = "wood";
		resMap = gameState.sharedScript.resourceMaps[resource];
	}

	for (let j of this.territoryIndices)
	{
		let i = territoryMap.getNonObstructedTile(j, radius, obstructions);
		if (i < 0)  // no room around
			continue;

		// we add 3 times the needed resource and once the others (except food)

		let total = resMap.map[j];

	//	total *= 0.7;   // Just a normalisation factor as the locateMap is limited to 255
		if (total <= bestVal)
			continue;

		let pos = [cellSize * (j%width+0.5), cellSize * (Math.floor(j/width)+0.5)];

		for (let dp of dpEnts)
		{
			let dpPos = dp.position();
			if (!dpPos)
				continue;
			let dist = API3.SquareVectorDistance(dpPos, pos);
			if (dist < 200)
			{
				total = 0;
				break;
			}
			else if (dist < 6400)
				total *= (Math.sqrt(dist)-60)/20;
		}
		if (total <= bestVal)
			continue;

		if (gameState.ai.HQ.isDangerousLocation(gameState, pos, halfSize))
			continue;
		bestVal = total;
		bestIdx = i;
	}

	KIARA.Logger.trace(" for farmstead best is " + bestVal);

	if (bestVal <= 0)
		return { "quality": bestVal, "pos": [0, 0] };

	let x = (bestIdx % obstructions.width + 0.5) * obstructions.cellSize;
	let z = (Math.floor(bestIdx / obstructions.width) + 0.5) * obstructions.cellSize;
	return { "quality": bestVal, "pos": [x, z] };
}

KIARA.BaseManager.prototype.signalNoSupply = function(gameState, resource, cut = 10, reset = false)
{
	if (resource == "food" || resource == "farm") {
		gameState.ai.HQ.signalNoSupply(gameState, resource);
		return;
	}
	if (this.needDropsite[resource] && !reset)
		return;

	this.needDropsite[resource] = true;
	KIARA.Logger.trace("base need supply " + resource);
	let res = resource;
	// Try to build one
	if (res == "food" || res == "farm") {
		if (!this.buildFoodSupply(gameState, gameState.ai.queues, "dropsites", res))
			gameState.ai.HQ.signalNoSupply(gameState, resource);
		return;
	}

	if (!gameState.isTemplateAvailable(gameState.applyCiv(KIARA.Templates[KIARA.TemplateConstants.Dropsite]))) {
		KIARA.Logger.trace("signalNoSupply: cannot build storehouse");
		gameState.ai.HQ.signalNoSupply(gameState, resource);
		return;
	}

	let newDP = this.findBestDropsiteLocation(gameState, res);
	if (newDP.quality > cut)
		gameState.ai.queues["dropsites"].addPlan(new KIARA.ConstructionPlan(gameState, KIARA.Templates[KIARA.TemplateConstants.Dropsite], {"base": this.ID, "type": res}, newDP.pos));
	else
		gameState.ai.HQ.signalNoSupply(gameState, resource);
}

KIARA.BaseManager.prototype.buildFoodSupply = function(gameState, queues, type, res)
{
	if (!gameState.isTemplateAvailable(gameState.applyCiv(KIARA.Templates[KIARA.TemplateConstants.Farmstead])))
		return false;

	let newSF = this.findBestFarmsteadLocation(gameState, res);
	if (newSF.quality > 10) {
		queues[type].addPlan(new KIARA.ConstructionPlan(gameState, KIARA.Templates[KIARA.TemplateConstants.Farmstead], {"base": this.ID, "type": "food"}, newSF.pos));
		return true;
	}

	return this.buildField(gameState, queues);
}

KIARA.BaseManager.prototype.buildField = function(gameState, queues)
{
	if (!gameState.isTemplateAvailable(gameState.applyCiv(KIARA.Templates[KIARA.TemplateConstants.Field])))
		return false;
	queues.economicBuilding.addPlan(new KIARA.ConstructionPlan(gameState, KIARA.Templates[KIARA.TemplateConstants.Field]));
	return true;
}

KIARA.BaseManager.prototype.signalNoNeedSupply = function(gameState, resource)
{
	KIARA.Logger.trace("base no need supply " + resource);
	this.needDropsite[resource] = false;
	gameState.ai.HQ.signalNoNeedSupply(gameState, resource);
}


/**
 * Returns the position of the best place to build a new dropsite for the specified resource
 */
KIARA.BaseManager.prototype.findBestDropsiteLocation = function(gameState, resource)
{

	let template = gameState.getTemplate(gameState.applyCiv(KIARA.Templates[KIARA.TemplateConstants.Dropsite]));
	let halfSize = 0;
	if (template.get("Footprint/Square"))
		halfSize = Math.max(+template.get("Footprint/Square/@depth"), +template.get("Footprint/Square/@width")) / 2;
	else if (template.get("Footprint/Circle"))
		halfSize = +template.get("Footprint/Circle/@radius");

	// This builds a map. The procedure is fairly simple. It adds the resource maps
	//	(which are dynamically updated and are made so that they will facilitate DP placement)
	// Then checks for a good spot in the territory. If none, and town/city phase, checks outside
	// The AI will currently not build a CC if it wouldn't connect with an existing CC.

	let obstructions = KIARA.createObstructionMap(gameState, this.accessIndex, template);

	let ccEnts = gameState.getOwnStructures().filter(API3.Filters.byClass("CivCentre")).toEntityArray();
	let dpEnts = gameState.getOwnStructures().filter(API3.Filters.byClasses(["Storehouse", "Dock"])).toEntityArray();

	let bestIdx;
	let bestVal = 0;
	let rr = template.obstructionRadius().max/2;
	rr = rr * rr;
	let radius = Math.ceil(template.obstructionRadius().max / obstructions.cellSize);

	let territoryMap = gameState.ai.HQ.territoryMap;
	let width = territoryMap.width;
	let cellSize = territoryMap.cellSize;

	let isWood = resource == "wood";
	let cut = 300;
	if (isWood)
		cut = 100;
	let useAny = false;
	if (resource == "any") {
		resource = "wood";
		useAny = true;
	}

	if (!this.dropsiteSupplies[resource].nearby.length)
		cut = 0;

	for (let j of this.territoryIndices)
	{
		let i = territoryMap.getNonObstructedTile(j, radius, obstructions);
		if (i < 0)  // no room around
			continue;

		let total = gameState.sharedScript.resourceMaps[resource].map[j];
		if (useAny) {
			for (let res in gameState.sharedScript.resourceMaps)
				if (res != "food")
					total += gameState.sharedScript.resourceMaps[res].map[j];
		}
		//	if (isWood)
		//		total *= 0.7;   // Just a normalisation factor as the locateMap is limited to 255
		if (total <= bestVal)
			continue;

		let pos = [cellSize * (j%width+0.5), cellSize * (Math.floor(j/width)+0.5)];

		for (let dp of dpEnts)
		{
			let dpPos = dp.position();
			if (!dpPos)
				continue;
			let rr2 = dp.obstructionRadius().max/2;
			let dist = API3.SquareVectorDistance(dpPos, pos) - rr - (rr2*rr2);
			if (dist < cut)
			{
				total = 0;
				break;
			}
			if (dp.getMetadata(PlayerID, "type") == resource && !isWood && dist < 60*60) {
				total = 0;
				break;
			}
		}
		if (total <= bestVal)
			continue;
/*
		for (let cc of ccEnts)
		{
			let ccPos = cc.position();
			if (!ccPos)
				continue;
			let dist = API3.SquareVectorDistance(ccPos, pos);
			if (dist < 500)
			{
				total = 0;
				break;
			}
			else if (dist < 6400)
				total *= (Math.sqrt(dist)-60)/20;
		}
*/
		if (total <= bestVal)
			continue;
		if (gameState.ai.HQ.isDangerousLocation(gameState, pos, halfSize))
			continue;
		bestVal = total;
		bestIdx = i;
	}

	KIARA.Logger.trace(" for dropsite best is " + bestVal);

	if (bestVal <= 0)
		return { "quality": bestVal, "pos": [0, 0] };

	let x = (bestIdx % obstructions.width + 0.5) * obstructions.cellSize;
	let z = (Math.floor(bestIdx / obstructions.width) + 0.5) * obstructions.cellSize;
	return { "quality": bestVal, "pos": [x, z] };
};

KIARA.BaseManager.prototype.getResourceLevel = function(gameState, type, nearbyOnly = false)
{
	let count = 0;
	let check = {};
	for (let supply of this.dropsiteSupplies[type].nearby)
	{
		if (check[supply.id])    // avoid double counting as same resource can appear several time
			continue;
		check[supply.id] = true;
		count += supply.ent.resourceSupplyAmount();
	}
	if (nearbyOnly)
		return count;

	for (let supply of this.dropsiteSupplies[type].medium)
	{
		if (check[supply.id])
			continue;
		check[supply.id] = true;
		count += 0.6*supply.ent.resourceSupplyAmount();
	}
	return count;
};

/** check our resource levels and react accordingly */
KIARA.BaseManager.prototype.checkResourceLevels = function(gameState, queues)
{
};

/** Adds the estimated gather rates from this base to the currentRates */
KIARA.BaseManager.prototype.addGatherRates = function(gameState, currentRates)
{
	for (let res in currentRates)
	{
		// I calculate the exact gathering rate for each unit.
		// I must then lower that to account for travel time.
		// Given that the faster you gather, the more travel time matters,
		// I use some logarithms.
		// TODO: this should take into account for unit speed and/or distance to target

		this.gatherersByType(gameState, res).forEach(ent => {
			if (ent.isIdle() || !ent.position())
				return;
			let gRate = ent.currentGatherRate();
			if (gRate)
				currentRates[res] += Math.log(1+gRate)/1.1;
		});
		if (res == "food")
		{
			this.workersBySubrole(gameState, "hunter").forEach(ent => {
				if (ent.isIdle() || !ent.position())
					return;
				let gRate = ent.currentGatherRate();
				if (gRate)
					currentRates[res] += Math.log(1+gRate)/1.1;
			});
			this.workersBySubrole(gameState, "fisher").forEach(ent => {
				if (ent.isIdle() || !ent.position())
					return;
				let gRate = ent.currentGatherRate();
				if (gRate)
					currentRates[res] += Math.log(1+gRate)/1.1;
			});
		}
	}
};

KIARA.BaseManager.prototype.assignRolelessUnits = function(gameState, roleless)
{
	if (!roleless)
		roleless = this.units.filter(API3.Filters.not(API3.Filters.byHasMetadata(PlayerID, "role"))).values();

	for (let ent of roleless)
	{
		if (ent.hasClass("Worker") || ent.hasClass("CitizenSoldier") || ent.hasClass("FishingBoat"))
			ent.setMetadata(PlayerID, "role", "worker");
		else if (ent.hasClass("FastMoving"))
			ent.setMetadata(PlayerID, "role", "hunter");
		else if (ent.hasClass("Support") && ent.hasClass("Elephant"))
			ent.setMetadata(PlayerID, "role", "worker");
	}

	let retreating = this.units.filter(API3.Filters.byMetadata(PlayerID, "role", "retreat")).values();
	for (let ent of retreating)
	{
		if (ent.isIdle())
		{
			if (ent.hasClass("Worker") || ent.hasClass("CitizenSoldier") || ent.hasClass("FishingBoat"))
				ent.setMetadata(PlayerID, "role", "worker");
			else if (ent.hasClass("FastMoving"))
				ent.setMetadata(PlayerID, "role", "hunter");
			else if (ent.hasClass("Support") && ent.hasClass("Elephant"))
				ent.setMetadata(PlayerID, "role", "worker");
			else
				ent.setMetadata(PlayerID, "role", undefined);
			const stance = ent.hasClass("Support") ? KIARA.Stances.FLEE : KIARA.Stances.DEFEND;
			ent.setStance(stance);
		}
	}
};

/**
 * If the numbers of workers on the resources is unbalanced then set some of workers to idle so
 * they can be reassigned by reassignIdleWorkers.
 * TODO: actually this probably should be in the HQ.
 */
KIARA.BaseManager.prototype.setWorkersIdleByPriority = function(gameState)
{
	this.timeNextIdleCheck = gameState.ai.elapsedTime + 8;
	// change resource only towards one which is more needed, and if changing will not change this order
	let nb = 1;    // no more than 1 change per turn (otherwise we should update the rates)
	let mostNeeded = gameState.ai.HQ.pickMostNeededResources(gameState);
	let sumWanted = 0;
	let sumCurrent = 0;
	for (let need of mostNeeded)
	{
		sumWanted += need.wanted;
		sumCurrent += need.current;
	}
	let scale = 1;
	if (sumWanted > 0)
		scale = sumCurrent / sumWanted;

	//Check how many farms we have, and move women to them
	let nFields = gameState.getOwnEntitiesByClass("Field", true).length  + gameState.getOwnFoundationsByClass("Field").length;
	let nGatherers = this.gatherersByType(gameState, "food").filter((ent) => ent.hasClass("FemaleCitizen")).length;
	let missing = Math.max(0, nFields * 5 - nGatherers);
	if (missing)
	{
		let cycle = ["metal", "stone", "wood"];
		for (let type of cycle)
		{
			missing = this.switchGatherer(gameState, cycle, "food", missing);
			if (!missing)
				break;
		}
	}

	for (let i = mostNeeded.length-1; i > 0; --i)
	{
		let lessNeed = mostNeeded[i];
		for (let j = 0; j < i; ++j)
		{
			let moreNeed = mostNeeded[j];
			let lastFailed = gameState.ai.HQ.lastFailedGather[moreNeed.type];
			if (lastFailed && gameState.ai.elapsedTime - lastFailed < 20)
				continue;
			// Ensure that the most wanted resource is not exhausted
			if (moreNeed.type != "food" && gameState.ai.HQ.isResourceExhausted(moreNeed.type))
			{
				if (lessNeed.type != "food" && gameState.ai.HQ.isResourceExhausted(lessNeed.type))
					continue;

				// And if so, move the gatherer to the less wanted one.
				nb = this.switchGatherer(gameState, moreNeed.type, lessNeed.type, nb);
				if (nb == 0)
					return;
			}
			if (lessNeed.type == "food")
				continue;
			// If we assume a mean rate of 0.5 per gatherer, this diff should be > 1
			// but we require a bit more to avoid too frequent changes
			if (scale*moreNeed.wanted - moreNeed.current - scale*lessNeed.wanted + lessNeed.current > 1.5 ||
			    lessNeed.type != "food" && gameState.ai.HQ.isResourceExhausted(lessNeed.type))
			{
				nb = this.switchGatherer(gameState, lessNeed.type, moreNeed.type, nb);
				if (nb == 0)
					return;
			}
		}
	}
};

/**
 * Switch some gatherers (limited to number) from resource "from" to resource "to"
 * and return remaining number of possible switches.
 * Prefer FemaleCitizen for food and CitizenSoldier for other resources.
 */
KIARA.BaseManager.prototype.switchGatherer = function(gameState, from, to, number)
{
	let num = number;
	let gatherers = this.gatherersByType(gameState, from);

	for (let ent of gatherers.values())
	{
		if (num == 0)
			return num;
		if (!ent.canGather(to))
			continue;
		if (to == "food" && !ent.hasClass("FemaleCitizen") && !ent.hasClass("Cavalry"))
			continue;
		if (to != "food" && !ent.hasClass("CitizenSoldier"))
			continue;
		--num;
		ent.stopMoving();
		ent.setMetadata(PlayerID, "gather-type", to);
		gameState.ai.HQ.AddTCResGatherer(to, ent.resourceGatherRates());
	}
	return num;
};

KIARA.BaseManager.prototype.reassignIdleWorkers = function(gameState, idleWorkers)
{
	// Search for idle workers, and tell them to gather resources based on demand
	if (!idleWorkers)
	{
		let filter = API3.Filters.byMetadata(PlayerID, "subrole", "idle");
		idleWorkers = gameState.updatingCollection("idle-workers-base-" + this.ID, filter, this.workers).toEntityArray();
		idleWorkers = idleWorkers.sort((a, b) => {
			if (a.hasClass("FemaleCitizen") && !b.hasClass("FemaleCitizen"))
				return -1;
			return 1;
		});	}

	let mostNeeded = gameState.ai.HQ.pickMostNeededResources(gameState);
	KIARA.Logger.warn("reasignIdleWorkers: mostNeeded = " + uneval(mostNeeded));
	for (let ent of idleWorkers)
	{
		// Check that the worker isn't garrisoned
		if (!ent.position())
			continue;

		if (ent.hasClass("Worker"))
		{
			// Just emergency repairing here. It is better managed in assignToFoundations
			if (ent.isBuilder() && this.anchor && this.anchor.needsRepair() &&
				gameState.getOwnEntitiesByMetadata("target-foundation", this.anchor.id()).length < 2)
				ent.repair(this.anchor);
			else if (ent.isGatherer())
			{
				let usedPriority = false;
				let notFound = true;
				for (let needed of mostNeeded)
				{
					if (!ent.canGather(needed.type))
						continue;
					let lastFailed = gameState.ai.HQ.lastFailedGather[needed.type];
					if (lastFailed && gameState.ai.elapsedTime - lastFailed < 20)
						continue;
					if (needed.type != "food" && gameState.ai.HQ.isResourceExhausted(needed.type))
						continue;
					if (needed.type == "food" && ent.hasClass("CitizenSoldier")) {
						usedPriority = true;
						continue;
					}
					if (needed.type != "food" && ent.hasClass("FemaleCitizen")) {
						usedPriority = true;
						continue;
					}
					if ((needed.type == "metal" || needed.type == "stone") && !needed.wanted) {
						usedPriority = true;
						continue;
					}
					ent.setMetadata(PlayerID, "subrole", "gatherer");
					ent.setMetadata(PlayerID, "gather-type", needed.type);
					gameState.ai.HQ.AddTCResGatherer(needed.type, ent.resourceGatherRates());
					break;
				}
				if (usedPriority) {
					for (let needed of mostNeeded)
					{
						if (!ent.canGather(needed.type))
							continue;
						let lastFailed = gameState.ai.HQ.lastFailedGather[needed.type];
						if (lastFailed && gameState.ai.elapsedTime - lastFailed < 20)
							continue;
						if (needed.type != "food" && gameState.ai.HQ.isResourceExhausted(needed.type))
							continue;
						if (needed.type == "food" && ent.hasClass("CitizenSoldier")) {
							continue;
						}
						if ((needed.type == "metal" || needed.type == "stone") && !needed.wanted) {
							continue;
						}
						ent.setMetadata(PlayerID, "subrole", "gatherer");
						ent.setMetadata(PlayerID, "gather-type", needed.type);
						gameState.ai.HQ.AddTCResGatherer(needed.type, ent.resourceGatherRates());
						break;
					}
				}
			}
		}
		else if (KIARA.isFastMoving(ent) && ent.canGather("food") && ent.canAttackClass("Animal"))
			ent.setMetadata(PlayerID, "subrole", "hunter");
		else if (ent.hasClass("FishingBoat"))
			ent.setMetadata(PlayerID, "subrole", "fisher");
	}
};

KIARA.BaseManager.prototype.workersBySubrole = function(gameState, subrole)
{
	return gameState.updatingCollection("subrole-" + subrole +"-base-" + this.ID, API3.Filters.byMetadata(PlayerID, "subrole", subrole), this.workers);
};

KIARA.BaseManager.prototype.gatherersByType = function(gameState, type)
{
	return gameState.updatingCollection("workers-gathering-" + type +"-base-" + this.ID, API3.Filters.byMetadata(PlayerID, "gather-type", type), this.workersBySubrole(gameState, "gatherer"));
};

/**
 * returns an entity collection of workers.
 * They are idled immediatly and their subrole set to idle.
 */
KIARA.BaseManager.prototype.pickBuilders = function(gameState, workers, number)
{
	let availableWorkers = this.workers.filter(ent => {
		if (!ent.position() || !ent.isBuilder())
			return false;
		if (ent.getMetadata(PlayerID, "plan") == -2 || ent.getMetadata(PlayerID, "plan") == -3)
			return false;
		if (ent.getMetadata(PlayerID, "transport"))
			return false;
		return true;
	}).toEntityArray();
	availableWorkers.sort((a, b) => {
		let vala = 0;
		let valb = 0;
/*
		if (a.getMetadata(PlayerID, "subrole") == "builder")
			vala = 100;
		if (b.getMetadata(PlayerID, "subrole") == "builder")
			valb = 100;
*/
		if (a.getMetadata(PlayerID, "subrole") == "idle")
			vala = -50;
		if (b.getMetadata(PlayerID, "subrole") == "idle")
			valb = -50;
		if (a.getMetadata(PlayerID, "plan") === undefined)
			vala = -20;
		if (b.getMetadata(PlayerID, "plan") === undefined)
			valb = -20;
		if (a.hasClass("CitizenSoldier"))
			vala = vala + 30;
		if (b.hasClass("CitizenSoldier"))
			valb = valb + 30;
		return vala - valb;
	});
	let needed = Math.min(number, availableWorkers.length - 3);
	for (let i = 0; i < needed; ++i)
	{
		availableWorkers[i].stopMoving();
		availableWorkers[i].setMetadata(PlayerID, "subrole", "idle");
		workers.addEnt(availableWorkers[i]);
	}
	return;
};

/**
 * If we have some foundations, and we don't have enough builder-workers,
 * try reassigning some other workers who are nearby
 * AI tries to use builders sensibly, not completely stopping its econ.
 */
KIARA.BaseManager.prototype.assignToFoundations = function(gameState, noRepair)
{
	let foundations = this.buildings.filter(API3.Filters.and(API3.Filters.isFoundation(), API3.Filters.not(API3.Filters.byClass("Field"))));

	let damagedBuildings = this.buildings.filter(ent => ent.foundationProgress() === undefined && ent.needsRepair());

	// Check if nothing to build
	if (!foundations.length && !damagedBuildings.length)
		return;

	let workers = this.workers.filter(ent => ent.isBuilder());
	let builderWorkers = this.workersBySubrole(gameState, "builder");
	let idleBuilderWorkers = builderWorkers.filter(API3.Filters.isIdle());

	// if we're constructing and we have the foundations to our base anchor, only try building that.
	if (this.constructing && foundations.filter(API3.Filters.byMetadata(PlayerID, "baseAnchor", true)).hasEntities())
	{
		foundations = foundations.filter(API3.Filters.byMetadata(PlayerID, "baseAnchor", true));
		let tID = foundations.toEntityArray()[0].id();
		workers.forEach(ent => {
			let target = ent.getMetadata(PlayerID, "target-foundation");
			if (target && target != tID)
			{
				ent.stopMoving();
				ent.setMetadata(PlayerID, "target-foundation", tID);
			}
		});
	}

	if (workers.length < 3)
	{
		let fromOtherBase = gameState.ai.HQ.bulkPickWorkers(gameState, this, 2);
		if (fromOtherBase)
		{
			let baseID = this.ID;
			fromOtherBase.forEach(worker => {
				worker.setMetadata(PlayerID, "base", baseID);
				worker.setMetadata(PlayerID, "subrole", "builder");
				workers.updateEnt(worker);
				builderWorkers.updateEnt(worker);
				idleBuilderWorkers.updateEnt(worker);
			});
		}
	}

	let builderTot = builderWorkers.length - idleBuilderWorkers.length;

	// Make the limit on number of builders depends on the available resources
	let availableResources = gameState.ai.queueManager.getAvailableResources(gameState);
	let builderRatio = 1;
/*
	for (let res of Resources.GetCodes())
	{
		if (availableResources[res] < 200)
		{
			builderRatio = 0.2;
			break;
		}
		else if (availableResources[res] < 1000)
			builderRatio = Math.min(builderRatio, availableResources[res] / 1000);
	}
*/
	for (let target of foundations.values())
	{

		if (gameState.ai.HQ.isNearInvadingArmy(target.position()))
			if (!target.hasClass("CivCentre") && !target.hasClass("Wall") &&
			    (!target.hasClass("Wonder") || !gameState.getVictoryConditions().has("wonder")))
				continue;

		// if our territory has shrinked since this foundation was positioned, do not build it
		if (KIARA.isNotWorthBuilding(gameState, target))
			continue;

		let assigned = gameState.getOwnEntitiesByMetadata("target-foundation", target.id()).length;
		let maxTotalBuilders = Math.ceil(workers.length * builderRatio);
		if (maxTotalBuilders < 2 && workers.length > 1)
			maxTotalBuilders = 2;
		if (target.hasClass("House") && gameState.getPopulationLimit() < gameState.getPopulation() + 5 &&
		    gameState.getPopulationLimit() < gameState.getPopulationMax())
			maxTotalBuilders += 2;
		if (target.hasClass("DropsiteFood"))
			maxTotalBuilders += 2;
		let targetNB = 2;
		if (target.hasClass("Fortress") || target.hasClass("Wonder") || target.hasClass("CivCentre"))
			targetNB = 20;
		else if (target.hasClass("Barracks") || target.hasClass("Range") || target.hasClass("Stable") ||
			target.hasClass("Tower") || target.hasClass("Market"))
			targetNB = 4;
		else if (target.hasClass("House") || target.hasClass("DropsiteWood"))
			targetNB = 3;

		if (target.getMetadata(PlayerID, "baseAnchor") == true ||
		    target.hasClass("Wonder") && gameState.getVictoryConditions().has("wonder"))
		{
			targetNB = 40;
			maxTotalBuilders = Math.max(maxTotalBuilders, 40);
		}

		// if no base yet, everybody should build
		if (gameState.ai.HQ.numActiveBases() == 0)
		{
			targetNB = workers.length;
			maxTotalBuilders = targetNB;
		}

		if (assigned >= targetNB)
			continue;
		idleBuilderWorkers.forEach(function(ent) {
			if (ent.getMetadata(PlayerID, "target-foundation") !== undefined)
				return;
			if (assigned >= targetNB || !ent.position() ||
			    API3.SquareVectorDistance(ent.position(), target.position()) > 40000)
				return;
			++assigned;
			++builderTot;
			ent.setMetadata(PlayerID, "target-foundation", target.id());
		});
		if (assigned >= targetNB || builderTot >= maxTotalBuilders)
			continue;
		let nonBuilderWorkers = workers.filter(function(ent) {
			if (ent.getMetadata(PlayerID, "subrole") == "builder")
				return false;
			if (!ent.position())
				return false;
			if (ent.getMetadata(PlayerID, "plan") == -2 || ent.getMetadata(PlayerID, "plan") == -3)
				return false;
			if (ent.getMetadata(PlayerID, "transport"))
				return false;
			return true;
		}).toEntityArray();
		let time = target.buildTime();
		nonBuilderWorkers.sort((workerA, workerB) => {
			let coeffA = API3.SquareVectorDistance(target.position(), workerA.position());
			if (workerA.getMetadata(PlayerID, "gather-type") == "food")
				coeffA *= 3;
			let coeffB = API3.SquareVectorDistance(target.position(), workerB.position());
			if (workerB.getMetadata(PlayerID, "gather-type") == "food")
				coeffB *= 3;
			return coeffA - coeffB;
		});
		let current = 0;
		let nonBuilderTot = nonBuilderWorkers.length;
		while (assigned < targetNB && builderTot < maxTotalBuilders && current < nonBuilderTot)
		{
			++assigned;
			++builderTot;
			let ent = nonBuilderWorkers[current++];
			ent.stopMoving();
			ent.setMetadata(PlayerID, "subrole", "builder");
			ent.setMetadata(PlayerID, "target-foundation", target.id());
		}
	}

	for (let target of damagedBuildings.values())
	{
		// Don't repair if we're still under attack, unless it's a vital (civcentre or wall) building
		// that's being destroyed.
		if (gameState.ai.HQ.isNearInvadingArmy(target.position()))
		{
			if (target.healthLevel() > 0.5 ||
			    !target.hasClass("CivCentre") && !target.hasClass("Wall") &&
			    (!target.hasClass("Wonder") || !gameState.getVictoryConditions().has("wonder")))
				continue;
		}
		else if (noRepair && !target.hasClass("CivCentre"))
			continue;

		if (target.decaying())
			continue;

		let assigned = gameState.getOwnEntitiesByMetadata("target-foundation", target.id()).length;
		let maxTotalBuilders = Math.ceil(workers.length * builderRatio);
		let targetNB = 1;
		if (target.hasClass("Fortress") || target.hasClass("Wonder"))
			targetNB = 15;
		if (target.getMetadata(PlayerID, "baseAnchor") == true ||
		    target.hasClass("Wonder") && gameState.getVictoryConditions().has("wonder"))
		{
			maxTotalBuilders = Math.ceil(workers.length * Math.max(0.3, builderRatio));
			targetNB = 5;
			if (target.healthLevel() < 0.3)
			{
				maxTotalBuilders = Math.ceil(workers.length * Math.max(0.6, builderRatio));
				targetNB = 7;
			}

		}

		if (assigned >= targetNB)
			continue;
		idleBuilderWorkers.forEach(function(ent) {
			if (ent.getMetadata(PlayerID, "target-foundation") !== undefined)
				return;
			if (assigned >= targetNB || !ent.position() ||
			    API3.SquareVectorDistance(ent.position(), target.position()) > 40000)
				return;
			++assigned;
			++builderTot;
			ent.setMetadata(PlayerID, "target-foundation", target.id());
		});
		if (assigned >= targetNB || builderTot >= maxTotalBuilders)
			continue;
		let nonBuilderWorkers = workers.filter(function(ent) {
			if (ent.getMetadata(PlayerID, "subrole") == "builder")
				return false;
			if (!ent.position())
				return false;
			if (ent.getMetadata(PlayerID, "plan") == -2 || ent.getMetadata(PlayerID, "plan") == -3)
				return false;
			if (ent.getMetadata(PlayerID, "transport"))
				return false;
			return true;
		});
		let num = Math.min(nonBuilderWorkers.length, targetNB-assigned);
		let nearestNonBuilders = nonBuilderWorkers.filterNearest(target.position(), num);

		nearestNonBuilders.forEach(function(ent) {
			++assigned;
			++builderTot;
			ent.stopMoving();
			ent.setMetadata(PlayerID, "subrole", "builder");
			ent.setMetadata(PlayerID, "target-foundation", target.id());
		});
	}
};

/** Return false when the base is not active (no workers on it) */
KIARA.BaseManager.prototype.update = function(gameState, queues, events)
{
	if (this.ID == gameState.ai.HQ.baseManagers[0].ID)	// base for unaffected units
	{
		// if some active base, reassigns the workers/buildings
		// otherwise look for anything useful to do, i.e. treasures to gather
		if (gameState.ai.HQ.numActiveBases() > 0)
		{
			for (let ent of this.units.values())
			{
				let bestBase = KIARA.getBestBase(gameState, ent);
				if (bestBase.ID != this.ID)
					bestBase.assignEntity(gameState, ent);
			}
			for (let ent of this.buildings.values())
			{
				let bestBase = KIARA.getBestBase(gameState, ent);
				if (!bestBase)
				{
					if (ent.hasClass("Dock"))
						KIARA.Logger.error("Kiara: dock in baseManager[0]. It may be useful to do an anchorless base for " + ent.templateName());
					continue;
				}
				if (ent.resourceDropsiteTypes())
					this.removeDropsite(gameState, ent);
				bestBase.assignEntity(gameState, ent);
			}
		}
		else if (gameState.ai.HQ.canBuildUnits)
		{
			this.assignToFoundations(gameState);
			if (gameState.ai.elapsedTime > this.timeNextIdleCheck)
				this.setWorkersIdleByPriority(gameState);
			this.assignRolelessUnits(gameState);
			this.reassignIdleWorkers(gameState);
			for (let ent of this.workers.values())
				this.workerObject.update(gameState, ent);
			for (let ent of this.mobileDropsites.values())
				this.workerObject.moveToGatherer(gameState, ent, false);
		}
		return false;
	}

	if (!this.anchor)   // This anchor has been destroyed, but the base may still be usable
	{
		if (!this.buildings.hasEntities())
		{
			// Reassign all remaining entities to its nearest base
			for (let ent of this.units.values())
			{
				let base = KIARA.getBestBase(gameState, ent, false, this.ID);
				base.assignEntity(gameState, ent);
			}
			return false;
		}
		// If we have a base with anchor on the same land, reassign everything to it
		let reassignedBase;
		for (let ent of this.buildings.values())
		{
			if (!ent.position())
				continue;
			let base = KIARA.getBestBase(gameState, ent);
			if (base.anchor)
				reassignedBase = base;
			break;
		}

		if (reassignedBase)
		{
			for (let ent of this.units.values())
				reassignedBase.assignEntity(gameState, ent);
			for (let ent of this.buildings.values())
			{
				if (ent.resourceDropsiteTypes())
					this.removeDropsite(gameState, ent);
				reassignedBase.assignEntity(gameState, ent);
			}
			return false;
		}

		this.assignToFoundations(gameState);
		if (gameState.ai.elapsedTime > this.timeNextIdleCheck)
			this.setWorkersIdleByPriority(gameState);
		this.assignRolelessUnits(gameState);
		this.reassignIdleWorkers(gameState);
		for (let ent of this.workers.values())
			this.workerObject.update(gameState, ent);
		for (let ent of this.mobileDropsites.values())
			this.workerObject.moveToGatherer(gameState, ent, false);
		return true;
	}

	Engine.ProfileStart("Base update - base " + this.ID);

	this.checkResourceLevels(gameState, queues);
	this.assignToFoundations(gameState);

	if (this.constructing)
	{
		let owner = gameState.ai.HQ.territoryMap.getOwner(this.anchor.position());
		if(owner != 0 && !gameState.isPlayerAlly(owner))
		{
			// we're in enemy territory. If we're too close from the enemy, destroy us.
			let ccEnts = gameState.updatingGlobalCollection("allCCs", API3.Filters.byClass("CivCentre"));
			for (let cc of ccEnts.values())
			{
				if (cc.owner() != owner)
					continue;
				if (API3.SquareVectorDistance(cc.position(), this.anchor.position()) > 8000)
					continue;
				this.anchor.destroy();
				gameState.ai.HQ.resetBaseCache();
				break;
			}
		}
	}
	else if (this.neededDefenders && gameState.ai.HQ.trainEmergencyUnits(gameState, [this.anchor.position()]))
		--this.neededDefenders;

	if (gameState.ai.elapsedTime > this.timeNextIdleCheck &&
	   (gameState.currentPhase() > 1 || gameState.ai.HQ.phasing == 2))
		this.setWorkersIdleByPriority(gameState);

	this.assignRolelessUnits(gameState);
	this.reassignIdleWorkers(gameState);
	// check if workers can find something useful to do
	for (let ent of this.workers.values())
		this.workerObject.update(gameState, ent);
	for (let ent of this.mobileDropsites.values())
		this.workerObject.moveToGatherer(gameState, ent, false);

	Engine.ProfileStop();
	return true;
};

KIARA.BaseManager.prototype.Serialize = function()
{
	return {
		"ID": this.ID,
		"anchorId": this.anchorId,
		"accessIndex": this.accessIndex,
		"maxDistResourceSquare": this.maxDistResourceSquare,
		"constructing": this.constructing,
		"gatherers": this.gatherers,
		"neededDefenders": this.neededDefenders,
		"territoryIndices": this.territoryIndices,
		"timeNextIdleCheck": this.timeNextIdleCheck
	};
};

KIARA.BaseManager.prototype.Deserialize = function(gameState, data)
{
	for (let key in data)
		this[key] = data[key];

	this.anchor = this.anchorId !== undefined ? gameState.getEntityById(this.anchorId) : undefined;
};
