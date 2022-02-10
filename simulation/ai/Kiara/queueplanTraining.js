KIARA.TrainingPlan = function(gameState, type, metadata, number = 1, maxMerge = 5, m_trainer = undefined)
{
	if (!KIARA.QueuePlan.call(this, gameState, type, metadata))
	{
		KIARA.Logger.debug(" Plan training " + type + " canceled");
		return false;
	}

	// Refine the estimated cost and add pop cost
	let trainers = m_trainer ? [m_trainer] : this.getBestTrainers(gameState);
	let trainer = trainers ? trainers[0] : undefined;
	this.cost = new API3.Resources(this.template.cost(trainer), +this.template._template.Cost.Population);

	this.category = "unit";
	this.number = number;
	this.maxMerge = maxMerge;

	if (m_trainer)
		this.trainer = m_trainer;

	return true;
};

KIARA.TrainingPlan.prototype = Object.create(KIARA.QueuePlan.prototype);

KIARA.TrainingPlan.prototype.canStart = function(gameState)
{
	if (this.allreadyStarted())
		return false;
	this.trainers = this.trainer ? [this.trainer] : this.getBestTrainers(gameState);
	if (!this.trainers)
		return false;
	this.cost = new API3.Resources(this.template.cost(this.trainers[0]), +this.template._template.Cost.Population);
	return true;
};

KIARA.TrainingPlan.prototype.getBestTrainers = function(gameState)
{
	if (this.metadata && this.metadata.trainer)
	{
		let trainer = gameState.getEntityById(this.metadata.trainer);
		if (trainer)
			return [trainer];
	}

	let allTrainers = gameState.findTrainers(this.type);
	if (this.metadata && this.metadata.sea)
		allTrainers = allTrainers.filter(API3.Filters.byMetadata(PlayerID, "sea", this.metadata.sea));
	if (this.metadata && this.metadata.base)
		allTrainers = allTrainers.filter(API3.Filters.byMetadata(PlayerID, "base", this.metadata.base));
	if (!allTrainers || !allTrainers.hasEntities())
		return undefined;

	// Keep only trainers with smallest cost
	let costMin = Math.min();
	let trainers;
	for (let ent of allTrainers.values())
	{
		let cost = this.template.costSum(ent);
		if (cost === costMin)
			trainers.push(ent);
		else if (cost < costMin)
		{
			costMin = cost;
			trainers = [ent];
		}
	}
	return trainers;
};

KIARA.TrainingPlan.prototype.start = function(gameState)
{
	if (this.allreadyStarted())
		return false;
	if (this.metadata && this.metadata.trainer)
	{
		let metadata = {};
		for (let key in this.metadata)
			if (key !== "trainer")
				metadata[key] = this.metadata[key];
		this.metadata = metadata;
	}

	if (this.trainers.length > 1)
	{
		let wantedIndex;
		if (this.metadata && this.metadata.index)
			wantedIndex = this.metadata.index;
		let workerUnit = this.metadata && this.metadata.role && this.metadata.role == "worker";
		let supportUnit = this.template.hasClass("Support");
		this.trainers.sort(function(a, b) {
			// Prefer training buildings with short queues
			let aa = a.trainingQueueTime();
			let bb = b.trainingQueueTime();
			// Give priority to support units in the cc
			if (a.hasClass("Civic") && !supportUnit)
				aa += 10;
			if (b.hasClass("Civic") && !supportUnit)
				bb += 10;
			// And support units should not be too near to dangerous place
			if (supportUnit)
			{
				if (gameState.ai.HQ.isNearInvadingArmy(a.position()))
					aa += 50;
				if (gameState.ai.HQ.isNearInvadingArmy(b.position()))
					bb += 50;
			}
			// Give also priority to buildings with the right accessibility
			let aBase = a.getMetadata(PlayerID, "base");
			let bBase = b.getMetadata(PlayerID, "base");
			if (wantedIndex)
			{
				if (!aBase || gameState.ai.HQ.getBaseByID(aBase).accessIndex != wantedIndex)
					aa += 30;
				if (!bBase || gameState.ai.HQ.getBaseByID(bBase).accessIndex != wantedIndex)
					bb += 30;
			}
			// Then, if workers, small preference for bases with less workers
			if (workerUnit && aBase && bBase && aBase != bBase)
			{
				let apop = gameState.ai.HQ.getBaseByID(aBase).workers.length;
				let bpop = gameState.ai.HQ.getBaseByID(bBase).workers.length;
				if (apop > bpop)
					aa++;
				else if (bpop > apop)
					bb++;
			}
			return aa - bb;
		});
	}

	// spread load among all possible trainers
	let ln = this.trainers.length;
	let ideal = Math.max(1, Math.floor(this.number / 5));
	if (ln > ideal)
		ln = ideal;
	let number = Math.floor(this.number / ln);
	let nMissing = this.number - (number*ln);

	let civ = gameState.getPlayerCiv();
	let i = 1;
	while (i < ln) {
	//	KIARA.Logger.debug("spreading load with " + number);
		if (this.metadata && this.metadata.base !== undefined && this.metadata.base === 0)
			this.metadata.base = this.trainers[i].getMetadata(PlayerID, "base");
		this.trainers[i].train(civ, this.type, number, this.metadata);
		i++;
	}

	if (nMissing > 0)
		number = number + nMissing;

	i = 0;
	if (this.metadata && this.metadata.base !== undefined && this.metadata.base === 0)
		this.metadata.base = this.trainers[i].getMetadata(PlayerID, "base");
	this.trainers[i].train(civ, this.type, number, this.metadata);

	this.onStart(gameState);
};

KIARA.TrainingPlan.prototype.addItem = function(amount = 1)
{
	this.number += amount;
};

KIARA.TrainingPlan.prototype.Serialize = function()
{
	return {
		"category": this.category,
		"type": this.type,
		"ID": this.ID,
		"metadata": this.metadata,
		"cost": this.cost.Serialize(),
		"number": this.number,
		"maxMerge": this.maxMerge
	};
};

KIARA.TrainingPlan.prototype.Deserialize = function(gameState, data)
{
	for (let key in data)
		this[key] = data[key];

	this.cost = new API3.Resources();
	this.cost.Deserialize(data.cost);
};
