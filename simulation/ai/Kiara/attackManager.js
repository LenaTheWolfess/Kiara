/**
 * Attack Manager
 */
KIARA.AttackManager = function(Config)
{
	this.Config = Config;

	this.totalNumber = 0;
	this.attackNumber = 0;
	this.rushNumber = 0;
	this.dogRaidNumber = 0;
	this.raidNumber = 0;
	this.upcomingAttacks = {"DogRaid": [], "Anihilation": [], "Rush": [], "EarlyRaid": [], "Raid": [], "Attack": [], "HugeAttack": [], "MeleeRangeInfCav": [], "MeleeRangeCav": [], "MeleeCav": [], "RangeCav": [] };
	this.startedAttacks = {"DogRaid": [], "Anihilation": [], "Rush": [], "EarlyRaid": [], "Raid": [], "Attack": [], "HugeAttack": [], "MeleeRangeInfCav": [], "MeleeRangeCav": [], "MeleeCav": [], "RangeCav": [] };
	this.bombingAttacks = new Map();// Temporary attacks for siege units while waiting their current attack to start
	this.debugTime = 0;
	this.maxRushes = 0;
	this.rushSize = [];
	this.currentEnemyPlayer = undefined; // enemy player we are currently targeting
	this.defeated = {};
};

/** More initialisation for stuff that needs the gameState */
KIARA.AttackManager.prototype.init = function(gameState)
{
	this.outOfPlan = gameState.getOwnUnits().filter(API3.Filters.byMetadata(PlayerID, "plan", -1));
	this.outOfPlan.registerUpdates();
};

KIARA.AttackManager.prototype.setRushes = function(allowed)
{
	if (allowed > 3)
		allowed = 3;
	this.maxRushes = allowed;
	if (allowed > 3)
		this.maxRaids = 2;
	this.raidSize = [ 5, 10 ];
	this.rushSize = [ 16, 20, 24 ];

	this.maxRushes = 0;
	this.maxRaids = 0;
	this.maxDogRaids = 0;
};

KIARA.AttackManager.prototype.checkEvents = function(gameState, events)
{
	for (let evt of events.PlayerDefeated)
		this.defeated[evt.playerId] = true;

	let answer = "decline";
	let other;
	let targetPlayer;
	for (let evt of events.AttackRequest)
	{
		if (evt.source === PlayerID || !gameState.isPlayerAlly(evt.source) || !gameState.isPlayerEnemy(evt.player))
			continue;
		targetPlayer = evt.player;
		let available = 0;
		for (let attackType in this.upcomingAttacks)
		{
			for (let attack of this.upcomingAttacks[attackType])
			{
				if (attack.state === "completing")
				{
					if (attack.targetPlayer === targetPlayer)
						available += attack.unitCollection.length;
					else if (attack.targetPlayer !== undefined && attack.targetPlayer !== targetPlayer)
						other = attack.targetPlayer;
					continue;
				}

				attack.targetPlayer = targetPlayer;

				if (attack.unitCollection.length > 2)
					available += attack.unitCollection.length;
			}
		}

		if (available > 12)	// launch the attack immediately
		{
			for (let attackType in this.upcomingAttacks)
			{
				for (let attack of this.upcomingAttacks[attackType])
				{
					if (attack.state === "completing" ||
						attack.targetPlayer !== targetPlayer ||
						attack.unitCollection.length < 3)
						continue;
					attack.forceStart();
					attack.requested = true;
				}
			}
			answer = "join";
		}
		else if (other !== undefined)
			answer = "other";
		break;  // take only the first attack request into account
	}
	if (targetPlayer !== undefined)
		KIARA.chatAnswerRequestAttack(gameState, targetPlayer, answer, other);

	for (let evt of events.EntityRenamed)	// take care of packing units in bombing attacks
	{
		for (let [targetId, unitIds] of this.bombingAttacks)
		{
			if (targetId == evt.entity)
			{
				this.bombingAttacks.set(evt.newentity, unitIds);
				this.bombingAttacks.delete(evt.entity);
			}
			else if (unitIds.has(evt.entity))
			{
				unitIds.add(evt.newentity);
				unitIds.delete(evt.entity);
			}
		}
	}
};

/**
 * Check for any structure in range from within our territory, and bomb it
 */
KIARA.AttackManager.prototype.assignBombers = function(gameState)
{
	// First some cleaning of current bombing attacks
	for (let [targetId, unitIds] of this.bombingAttacks)
	{
		let target = gameState.getEntityById(targetId);
		if (!target || !gameState.isPlayerEnemy(target.owner()))
			this.bombingAttacks.delete(targetId);
		else
		{
			for (let entId of unitIds.values())
			{
				let ent = gameState.getEntityById(entId);
				if (ent && ent.owner() == PlayerID)
				{
					let plan = ent.getMetadata(PlayerID, "plan");
					let orders = ent.unitAIOrderData();
					let lastOrder = orders && orders.length ? orders[orders.length-1] : null;
					if (lastOrder && lastOrder.target && lastOrder.target == targetId && plan != -2 && plan != -3)
						continue;
				}
				unitIds.delete(entId);
			}
			if (!unitIds.size)
				this.bombingAttacks.delete(targetId);
		}
	}

	let bombers = gameState.updatingCollection("bombers", API3.Filters.byClasses(["BoltShooter", "StoneThrower"]), gameState.getOwnUnits());
	for (let ent of bombers.values())
	{
		if (!ent.position() || !ent.isIdle() || !ent.attackRange("Ranged"))
			continue;
		if (ent.getMetadata(PlayerID, "plan") == -2 || ent.getMetadata(PlayerID, "plan") == -3)
			continue;
		if (ent.getMetadata(PlayerID, "plan") !== undefined && ent.getMetadata(PlayerID, "plan") != -1)
		{
			let subrole = ent.getMetadata(PlayerID, "subrole");
			if (subrole && (subrole == "completing" || subrole == "walking" || subrole == "attacking"))
				continue;
		}
		let alreadyBombing = false;
		for (let unitIds of this.bombingAttacks.values())
		{
			if (!unitIds.has(ent.id()))
				continue;
			alreadyBombing = true;
			break;
		}
		if (alreadyBombing)
			break;

		let range = ent.attackRange("Ranged").max;
		let entPos = ent.position();
		let access = KIARA.getLandAccess(gameState, ent);
		for (let struct of gameState.getEnemyStructures().values())
		{
			if (!ent.canAttackTarget(struct, KIARA.allowCapture(gameState, ent, struct)))
				continue;

			let structPos = struct.position();
			let x;
			let z;
			if (struct.hasClass("Field"))
			{
				if (!struct.resourceSupplyNumGatherers() ||
				    !gameState.isPlayerEnemy(gameState.ai.HQ.territoryMap.getOwner(structPos)))
					continue;
			}
			let dist = API3.VectorDistance(entPos, structPos);
			if (dist > range)
			{
				let safety = struct.footprintRadius() + 30;
				x = structPos[0] + (entPos[0] - structPos[0]) * safety / dist;
				z = structPos[1] + (entPos[1] - structPos[1]) * safety / dist;
				let owner = gameState.ai.HQ.territoryMap.getOwner([x, z]);
				if (owner != 0 && gameState.isPlayerEnemy(owner))
					continue;
				x = structPos[0] + (entPos[0] - structPos[0]) * range / dist;
				z = structPos[1] + (entPos[1] - structPos[1]) * range / dist;
				if (gameState.ai.HQ.territoryMap.getOwner([x, z]) != PlayerID ||
				    gameState.ai.accessibility.getAccessValue([x, z]) != access)
					continue;
			}
			let attackingUnits;
			for (let [targetId, unitIds] of this.bombingAttacks)
			{
				if (targetId != struct.id())
					continue;
				attackingUnits = unitIds;
				break;
			}
			if (attackingUnits && attackingUnits.size > 4)
				continue;	// already enough units against that target
			if (!attackingUnits)
			{
				attackingUnits = new Set();
				this.bombingAttacks.set(struct.id(), attackingUnits);
			}
			attackingUnits.add(ent.id());
			if (dist > range)
				ent.move(x, z);
			ent.attack(struct.id(), false, dist > range);
			break;
		}
	}
};

/**
 * Some functions are run every turn
 * Others once in a while
 */
KIARA.AttackManager.prototype.update = function(gameState, queues, events)
{
	if (KIARA.Logger.isTrace() && gameState.ai.elapsedTime > this.debugTime + 60)
	{
		this.debugTime = gameState.ai.elapsedTime;
		KIARA.Logger.trace(" upcoming attacks =================");
		for (let attackType in this.upcomingAttacks)
			for (let attack of this.upcomingAttacks[attackType])
				KIARA.Logger.trace(" plan " + attack.name + " type " + attackType + " state " + attack.state + " units " + attack.unitCollection.length);
		KIARA.Logger.debug(" started attacks ==================");
		for (let attackType in this.startedAttacks)
			for (let attack of this.startedAttacks[attackType])
				KIARA.Logger.trace(" plan " + attack.name + " type " + attackType + " state " + attack.state + " units " + attack.unitCollection.length);
		KIARA.Logger.trace(" ==================================");
	}

	this.checkEvents(gameState, events);

	let popCaped = gameState.getPopulationMax() - gameState.getPopulation() < 5;
	let unexecutedAttacks = {"DogRaid": 0, "Anihilation": 0, "Rush": 0, "EarlyRaid": 0 ,"Raid": 0, "Attack": 0, "HugeAttack": 0, "MeleeRangeInfCav": 0, "MeleeRangeCav": 0, "MeleeCav": 0, "RangeCav": 0};
	let stopAllAttacks = gameState.ai.HQ.strategy == KIARA.Strategy.RECOVER;

	for (let attackType in this.upcomingAttacks)
	{
		for (let i = 0; i < this.upcomingAttacks[attackType].length; ++i)
		{
			let attack = this.upcomingAttacks[attackType][i];
			if (stopAllAttacks)
			{
				attack.Abort(gameState);
				KIARA.Logger.warn("Kiara stop attack " + attack.getType());
				this.upcomingAttacks[attackType].splice(i--, 1);
				continue;
			}

			attack.checkEvents(gameState, events);

			if (attack.isStarted())
				KIARA.Logger.debug("Kiara problem in attackManager: attack in preparation has already started ???");

			let updateStep = attack.updatePreparation(gameState);
			// now we're gonna check if the preparation time is over
			if (updateStep == 1 || attack.isPaused())
			{
				// just chillin'
				if (attack.state == "unexecuted")
					++unexecutedAttacks[attackType];
			}
			else if (updateStep == 0)
			{
				KIARA.Logger.warn("Attack Manager: " + attack.getType() + " plan " + attack.getName() + " aborted.");
				attack.Abort(gameState);
				this.upcomingAttacks[attackType].splice(i--, 1);
			}
			else if (updateStep == 2)
			{
				if (attack.StartAttack(gameState))
				{
					KIARA.Logger.debug("Attack Manager: Starting " + attack.getType() + " plan " + attack.getName());
					if (this.Config.chat)
						KIARA.chatLaunchAttack(gameState, attack.targetPlayer, attack.getType());
					this.startedAttacks[attackType].push(attack);
				}
				else
				{
					KIARA.Logger.warn("Failed to start " + attack.getType() + " -> abort");
					attack.Abort(gameState);
				}
				this.upcomingAttacks[attackType].splice(i--, 1);
			}
		}
	}

	for (let attackType in this.startedAttacks)
	{
		for (let i = 0; i < this.startedAttacks[attackType].length; ++i)
		{
			let attack = this.startedAttacks[attackType][i];
			attack.checkEvents(gameState, events);
			// okay so then we'll update the attack.
			if (attack.isPaused()) {
				KIARA.Logger.warn("attack '"+attackType+"' is paused");
				continue;
			}
			let remaining = attack.update(gameState, events);
			if (!remaining)
			{
				KIARA.Logger.warn("Military Manager: " + attack.getType() + " plan " + attack.getName() + " is finished with remaining " + remaining);
				attack.Abort(gameState);
				this.startedAttacks[attackType].splice(i--, 1);
			}
		}
	}

	// creating plans after updating because an aborted plan might be reused in that case.

	let doSmallAttacks = this.Config.behavior == "aggressive" && gameState.ai.HQ.strategy == KIARA.Strategy.ATTACK;
	let doEarlyRaid = gameState.ai.HQ.strategy == KIARA.Strategy.EARLY_RAID;
	let doDogRaid = gameState.ai.HQ.strategy == KIARA.Strategy.DOG_RAID;

	let barracksNb = gameState.getOwnEntitiesByClass("Barracks", true).filter(API3.Filters.isBuilt()).length;

	let stablesNb = gameState.getOwnEntitiesByClass("Stable", true).filter(API3.Filters.isBuilt()).length;

	if (doSmallAttacks && this.rushNumber < this.maxRushes && barracksNb >= 1)
	{
		if (unexecutedAttacks.Rush === 0)
		{
			// we have a barracks and we want to rush, rush.
			let data = { "targetSize": this.rushSize[this.rushNumber] };
			let attackPlan = new KIARA.AttackPlan(gameState, this.Config, this.totalNumber, KIARA.AttackTypes.RUSH, data);
			if (!attackPlan.failed)
			{
				KIARA.Logger.debug("Military Manager: Rushing plan " + this.totalNumber + " with maxRushes " + this.maxRushes);
				this.totalNumber++;
				attackPlan.init(gameState);
				this.upcomingAttacks.Rush.push(attackPlan);
			}
			this.rushNumber++;
		}
	}
	else if (doEarlyRaid && this.raidNumber < this.maxRaids)
	{
		if (unexecutedAttacks.EarlyRaid === 0)
		{
			let data = { "targetSize": this.raidSize[this.raidNumber] };
			let attackPlan = new KIARA.AttackPlan(gameState, this.Config, this.totalNumber, KIARA.AttackTypes.EARLY_RAID, data);
			if (!attackPlan.failed)
			{
				KIARA.Logger.debug("Military Manager: "+KIARA.AttackTypes.EARLY_RAID+" plan " + this.totalNumber + " with maxRaids " + this.maxRaids);
				this.totalNumber++;
				attackPlan.init(gameState);
				this.upcomingAttacks.EarlyRaid.push(attackPlan);
			}
			this.raidNumber++;
		}
	}
	else if (doDogRaid && this.dogRaidNumber < this.maxDogRaids && stablesNb)
	{
		if (unexecutedAttacks.DogRaid === 0)
		{
			let attackPlan = new KIARA.AttackPlan(gameState, this.Config, this.totalNumber, KIARA.AttackTypes.DOG_RAID, {});
			if (!attackPlan.failed)
			{
				KIARA.Logger.debug("Military Manager: "+KIARA.AttackTypes.DOG_RAID+" plan " + this.totalNumber + " with maxDogRaids " + this.maxDogRaids);
				this.totalNumber++;
				attackPlan.init(gameState);
				this.upcomingAttacks.DogRaid.push(attackPlan);
			}
			this.dogRaidNumber++;
		}
	}
	else if (unexecutedAttacks.Attack == 0 && unexecutedAttacks.HugeAttack == 0 &&
		this.startedAttacks.Attack.length + this.startedAttacks.HugeAttack.length < Math.min(2, 1 + Math.round(gameState.getPopulationMax()/100)) &&
		(this.startedAttacks.Attack.length + this.startedAttacks.HugeAttack.length == 0 || gameState.getPopulationMax() - gameState.getPopulation() > 12))
	{
		if (barracksNb >= 1 && (gameState.currentPhase() > 1 || gameState.isResearching(gameState.getPhaseName(2))) ||
			!gameState.ai.HQ.baseManagers[1])	// if we have no base ... nothing else to do than attack
		{
			let type = this.attackNumber < 2 || this.startedAttacks.HugeAttack.length > 0 ? KIARA.AttackTypes.ATTACK : KIARA.AttackTypes.HUGE_ATTACK;
			if (popCaped)
				type = KIARA.AttackTypes.HUGE_ATTACK;

			//This is hack, because i am lazy to do it properly
			type = KIARA.AttackTypes.HUGE_ATTACK;
			let attackPlan = new KIARA.AttackPlan(gameState, this.Config, this.totalNumber, type);
			if (attackPlan.failed)
				this.attackPlansEncounteredWater = true; // hack
			else
			{
				KIARA.Logger.debug("Military Manager: Creating the plan " + type + "  " + this.totalNumber);
				this.totalNumber++;
				attackPlan.init(gameState);
				this.upcomingAttacks[type].push(attackPlan);
			}
			this.attackNumber++;
		}
	}

	if (!popCaped && doSmallAttacks) {
		if (unexecutedAttacks.Raid === 0 && gameState.ai.HQ.defenseManager.targetList.length)
		{
			let target;
			for (let targetId of gameState.ai.HQ.defenseManager.targetList)
			{
				target = gameState.getEntityById(targetId);
				if (!target)
					continue;
				if (gameState.isPlayerEnemy(target.owner())) {
					this.raidTargetEntity(gameState, target);
				}
			}
		}

		// Check if we have some unused ranged siege unit which could do something useful while waiting
		if (doSmallAttacks && gameState.ai.playedTurn % 5 == 0)
			this.assignBombers(gameState);
	}
};

KIARA.AttackManager.prototype.getPlan = function(planName)
{
	for (let attackType in this.upcomingAttacks)
	{
		for (let attack of this.upcomingAttacks[attackType])
			if (attack.getName() == planName)
				return attack;
	}
	for (let attackType in this.startedAttacks)
	{
		for (let attack of this.startedAttacks[attackType])
			if (attack.getName() == planName)
				return attack;
	}
	return undefined;
};

KIARA.AttackManager.prototype.pausePlan = function(planName)
{
	let attack = this.getPlan(planName);
	if (attack)
		attack.setPaused(true);
};

KIARA.AttackManager.prototype.unpausePlan = function(planName)
{
	let attack = this.getPlan(planName);
	if (attack)
		attack.setPaused(false);
};

KIARA.AttackManager.prototype.pauseAllPlans = function()
{
	for (let attackType in this.upcomingAttacks)
		for (let attack of this.upcomingAttacks[attackType])
			attack.setPaused(true);

	for (let attackType in this.startedAttacks)
		for (let attack of this.startedAttacks[attackType])
			attack.setPaused(true);
};

KIARA.AttackManager.prototype.unpauseAllPlans = function()
{
	for (let attackType in this.upcomingAttacks)
		for (let attack of this.upcomingAttacks[attackType])
			attack.setPaused(false);

	for (let attackType in this.startedAttacks)
		for (let attack of this.startedAttacks[attackType])
			attack.setPaused(false);
};

KIARA.AttackManager.prototype.getAttackInPreparation = function(type)
{
	return this.upcomingAttacks[type].length ? this.upcomingAttacks[type][0] : undefined;
};

/**
 * Determine which player should be attacked: when called when starting the attack,
 * attack.targetPlayer is undefined and in that case, we keep track of the chosen target
 * for future attacks.
 */
KIARA.AttackManager.prototype.getEnemyPlayer = function(gameState, attack)
{
	let enemyPlayer;

	// First check if there is a preferred enemy based on our victory conditions.
	// If both wonder and relic, choose randomly between them TODO should combine decisions

	if (gameState.getVictoryConditions().has("wonder"))
		enemyPlayer = this.getWonderEnemyPlayer(gameState, attack);

	if (gameState.getVictoryConditions().has("capture_the_relic"))
		if (!enemyPlayer || randBool())
			enemyPlayer = this.getRelicEnemyPlayer(gameState, attack) || enemyPlayer;

	if (enemyPlayer)
		return enemyPlayer;

	let veto = {};
	for (let i in this.defeated)
		veto[i] = true;
	// No rush if enemy too well defended (i.e. iberians)
	if (attack.type == KIARA.AttackTypes.RUSH || attack.type == KIARA.AttackTypes.EARLY_RAID)
	{
		for (let i = 1; i < gameState.sharedScript.playersData.length; ++i)
		{
			if (!gameState.isPlayerEnemy(i) || veto[i])
				continue;
			if (this.defeated[i])
				continue;
			let enemyDefense = 0;
			let enemyUnits = gameState.getEnemyUnits(i).values();
			let enemyUnitSize = enemyUnits.length;
			let suports = 0;
			for (let ent of enemyUnits) {
				if (ent.hasClass("Support"))
					++suports;
			}
			if (suports / enemyUnitSize < 0.3) {
				veto[i] = true;
				continue;
			}
			for (let ent of gameState.getEnemyStructures(i).values())
				if (ent.hasClass("Tower") || ent.hasClass("WallTower") || ent.hasClass("Fortress"))
					enemyDefense++;
			if (enemyDefense > 3)
				veto[i] = true;
		}
	}

	// then if not a huge attack, continue attacking our previous target as long as it has some entities,
	// otherwise target the most accessible one
	if (attack.type != KIARA.AttackTypes.HUGE_ATTACK)
	{
		if (attack.targetPlayer === undefined && this.currentEnemyPlayer !== undefined &&
			!this.defeated[this.currentEnemyPlayer] &&
			gameState.isPlayerEnemy(this.currentEnemyPlayer) &&
			gameState.getEntities(this.currentEnemyPlayer).hasEntities())
			return this.currentEnemyPlayer;

		let distmin;
		let ccmin;
		let ccEnts = gameState.updatingGlobalCollection("allCCs", API3.Filters.byClass("CivCentre"));
		for (let ourcc of ccEnts.values())
		{
			if (ourcc.owner() != PlayerID)
				continue;
			let ourPos = ourcc.position();
			let access = KIARA.getLandAccess(gameState, ourcc);
			for (let enemycc of ccEnts.values())
			{
				if (veto[enemycc.owner()])
					continue;
				if (!gameState.isPlayerEnemy(enemycc.owner()))
					continue;
				if (access != KIARA.getLandAccess(gameState, enemycc))
					continue;
				let dist = API3.SquareVectorDistance(ourPos, enemycc.position());
				if (distmin && dist > distmin)
					continue;
				ccmin = enemycc;
				distmin = dist;
			}
		}
		if (ccmin)
		{
			enemyPlayer = ccmin.owner();
			if (attack.targetPlayer === undefined)
				this.currentEnemyPlayer = enemyPlayer;
			return enemyPlayer;
		}
	}

	// then let's target our strongest enemy (basically counting enemies units)
	// with priority to enemies with civ center
	let max = Math.min();
	for (let i = 1; i < gameState.sharedScript.playersData.length; ++i)
	{
		if (veto[i])
			continue;
		if (!gameState.isPlayerEnemy(i))
			continue;
		let enemyCount = gameState.getEnemyUnits(i).length;
		KIARA.Logger.debug("enemy " + i + " : " + enemyCount + " > " + max);
		if (enemyCount > max)
			continue;
		max = enemyCount;
		enemyPlayer = i;
	}
	if (attack.targetPlayer === undefined)
		this.currentEnemyPlayer = enemyPlayer;
	if (enemyPlayer === undefined)
		KIARA.Logger.debug("picking enemy is undefined");
	return enemyPlayer;
};

/**
 * Target the player with the most advanced wonder.
 * TODO currently the first built wonder is kept, should chek on the minimum wonderDuration left instead.
 */
KIARA.AttackManager.prototype.getWonderEnemyPlayer = function(gameState, attack)
{
	let enemyPlayer;
	let enemyWonder;
	let moreAdvanced;
	for (let wonder of gameState.getEnemyStructures().filter(API3.Filters.byClass("Wonder")).values())
	{
		if (wonder.owner() == 0)
			continue;
		let progress = wonder.foundationProgress();
		if (progress === undefined)
		{
			enemyWonder = wonder;
			break;
		}
		if (enemyWonder && moreAdvanced > progress)
			continue;
		enemyWonder = wonder;
		moreAdvanced = progress;
	}
	if (enemyWonder)
	{
		enemyPlayer = enemyWonder.owner();
		if (attack.targetPlayer === undefined)
			this.currentEnemyPlayer = enemyPlayer;
	}
	return enemyPlayer;
};

/**
 * Target the player with the most relics (including gaia).
 */
KIARA.AttackManager.prototype.getRelicEnemyPlayer = function(gameState, attack)
{
	let enemyPlayer;
	let allRelics = gameState.updatingGlobalCollection("allRelics", API3.Filters.byClass("Relic"));
	let maxRelicsOwned = 0;
	for (let i = 0; i < gameState.sharedScript.playersData.length; ++i)
	{
		if (!gameState.isPlayerEnemy(i) || this.defeated[i] ||
		    i == 0 && !gameState.ai.HQ.victoryManager.tryCaptureGaiaRelic)
			continue;

		let relicsCount = allRelics.filter(relic => relic.owner() == i).length;
		if (relicsCount <= maxRelicsOwned)
			continue;
		maxRelicsOwned = relicsCount;
		enemyPlayer = i;
	}
	if (enemyPlayer !== undefined)
	{
		if (attack.targetPlayer === undefined)
			this.currentEnemyPlayer = enemyPlayer;
		if (enemyPlayer == 0)
			gameState.ai.HQ.victoryManager.resetCaptureGaiaRelic(gameState);
	}
	return enemyPlayer;
};

/** f.e. if we have changed diplomacy with another player. */
KIARA.AttackManager.prototype.cancelAttacksAgainstPlayer = function(gameState, player)
{
	for (let attackType in this.upcomingAttacks)
		for (let attack of this.upcomingAttacks[attackType])
			if (attack.targetPlayer === player)
				attack.targetPlayer = undefined;

	for (let attackType in this.startedAttacks)
		for (let i = 0; i < this.startedAttacks[attackType].length; ++i)
		{
			let attack = this.startedAttacks[attackType][i];
			if (attack.targetPlayer === player)
			{
				attack.Abort(gameState);
				this.startedAttacks[attackType].splice(i--, 1);
			}
		}
};

KIARA.AttackManager.prototype.raidTargetEntity = function(gameState, ent)
{
	let data = { "target": ent };
	let attackPlan = new KIARA.AttackPlan(gameState, this.Config, this.totalNumber, KIARA.AttackTypes.RAID, data);
	if (attackPlan.failed)
		return null;
	KIARA.Logger.debug("Military Manager: Raiding plan " + this.totalNumber);
	this.raidNumber++;
	this.totalNumber++;
	attackPlan.init(gameState);
	this.upcomingAttacks.Raid.push(attackPlan);
	return attackPlan;
};

/**
 * Return the number of units from any of our attacking armies around this position
 */
KIARA.AttackManager.prototype.numAttackingUnitsAround = function(pos, dist)
{
	let num = 0;
	for (let attackType in this.startedAttacks)
		for (let attack of this.startedAttacks[attackType])
		{
			if (!attack.position)	// this attack may be inside a transport
				continue;
			if (API3.SquareVectorDistance(pos, attack.position) < dist*dist)
				num += attack.unitCollection.length;
		}
	return num;
};

/**
 * Switch defense armies into an attack one against the given target
 * data.range: transform all defense armies inside range of the target into a new attack
 * data.armyID: transform only the defense army ID into a new attack
 * data.uniqueTarget: the attack will stop when the target is destroyed or captured
 */
KIARA.AttackManager.prototype.switchDefenseToAttack = function(gameState, target, data)
{
	if (!target || !target.position())
		return false;
	if (!data.range && !data.armyID)
	{
		KIARA.Logger.error(" attackManager.switchDefenseToAttack inconsistent data " + uneval(data));
		return false;
	}
	let attackData = data.uniqueTarget ? { "uniqueTargetId": target.id() } : undefined;
	let pos = target.position();
	let attackType = KIARA.AttackTypes.ATTACK;
	let attackPlan = new KIARA.AttackPlan(gameState, this.Config, this.totalNumber, attackType, attackData);
	if (attackPlan.failed)
		return false;
	this.totalNumber++;
	attackPlan.init(gameState);
	this.startedAttacks[attackType].push(attackPlan);

	let targetAccess = KIARA.getLandAccess(gameState, target);
	for (let army of gameState.ai.HQ.defenseManager.armies)
	{
		if (data.range)
		{
			army.recalculatePosition(gameState);
			if (API3.SquareVectorDistance(pos, army.foePosition) > data.range * data.range)
				continue;
		}
		else if (army.ID != +data.armyID)
			continue;

		while (army.foeEntities.length > 0)
			army.removeFoe(gameState, army.foeEntities[0]);
		while (army.ownEntities.length > 0)
		{
			let unitId = army.ownEntities[0];
			army.removeOwn(gameState, unitId);
			let unit = gameState.getEntityById(unitId);
			let accessOk = unit.getMetadata(PlayerID, "transport") !== undefined ||
			               unit.position() && KIARA.getLandAccess(gameState, unit) == targetAccess;
			if (unit && accessOk && attackPlan.isAvailableUnit(gameState, unit))
			{
				unit.setMetadata(PlayerID, "plan", attackPlan.name);
				unit.setMetadata(PlayerID, "role", "attack");
				attackPlan.unitCollection.updateEnt(unit);
			}
		}
	}
	if (!attackPlan.unitCollection.hasEntities())
	{
		attackPlan.Abort(gameState);
		return false;
	}
	for (let unit of attackPlan.unitCollection.values())
		unit.setMetadata(PlayerID, "role", "attack");
	attackPlan.targetPlayer = target.owner();
	attackPlan.targetPos = pos;
	attackPlan.target = target;
	attackPlan.state = "arrived";
	//	attackPlan.RecreateGroups(gameState);
	//	attackPlan.RegroupAndAttack(gameState);
	return true;
};

KIARA.AttackManager.prototype.Serialize = function()
{
	let properties = {
		"totalNumber": this.totalNumber,
		"attackNumber": this.attackNumber,
		"rushNumber": this.rushNumber,
		"raidNumber": this.raidNumber,
		"debugTime": this.debugTime,
		"maxRushes": this.maxRushes,
		"rushSize": this.rushSize,
		"currentEnemyPlayer": this.currentEnemyPlayer,
		"defeated": this.defeated
	};

	let upcomingAttacks = {};
	for (let key in this.upcomingAttacks)
	{
		upcomingAttacks[key] = [];
		for (let attack of this.upcomingAttacks[key])
			upcomingAttacks[key].push(attack.Serialize());
	}

	let startedAttacks = {};
	for (let key in this.startedAttacks)
	{
		startedAttacks[key] = [];
		for (let attack of this.startedAttacks[key])
			startedAttacks[key].push(attack.Serialize());
	}

	return { "properties": properties, "upcomingAttacks": upcomingAttacks, "startedAttacks": startedAttacks };
};

KIARA.AttackManager.prototype.Deserialize = function(gameState, data)
{
	for (let key in data.properties)
		this[key] = data.properties[key];

	this.upcomingAttacks = {};
	for (let key in data.upcomingAttacks)
	{
		this.upcomingAttacks[key] = [];
		for (let dataAttack of data.upcomingAttacks[key])
		{
			let attack = new KIARA.AttackPlan(gameState, this.Config, dataAttack.properties.name);
			attack.Deserialize(gameState, dataAttack);
			attack.init(gameState);
			this.upcomingAttacks[key].push(attack);
		}
	}

	this.startedAttacks = {};
	for (let key in data.startedAttacks)
	{
		this.startedAttacks[key] = [];
		for (let dataAttack of data.startedAttacks[key])
		{
			let attack = new KIARA.AttackPlan(gameState, this.Config, dataAttack.properties.name);
			attack.Deserialize(gameState, dataAttack);
			attack.init(gameState);
			this.startedAttacks[key].push(attack);
		}
	}
};
