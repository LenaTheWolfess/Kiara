g_Commands["walk-to-range"] = function(player, cmd, data)
{
	// Only used by the AI
	GetFormationUnitAIs(data.entities, player, cmd, data.formation).forEach(cmpUnitAI => {
		cmpUnitAI.WalkToPointRange(cmd.x, cmd.z, cmd.min, cmd.max, cmd.queued);
	});
};

g_Commands["regroup"] = function(player, cmd, data)
{
	GetFormationUnitAIs(data.entities, player, cmd, data.formation, true).forEach(cmpUnitAI => {
		cmpUnitAI.MoveIntoFormation(cmd);
	});
};

/**
 * Returns a list of UnitAI components, each belonging either to a
 * selected unit or to a formation entity for groups of the selected units.
 */
function GetFormationUnitAIs(ents, player, cmd, formationTemplate, forceTemplate)
{
	// If an individual was selected, remove it from any formation
	// and command it individually.
	if (ents.length == 1)
	{
		let cmpUnitAI = Engine.QueryInterface(ents[0], IID_UnitAI);
		if (!cmpUnitAI)
			return [];

		RemoveFromFormation(ents);

		return [ cmpUnitAI ];
	}

	let formationUnitAIs = [];
	// Find what formations the selected entities are currently in,
	// and default to that unless the formation is forced or it's the null formation
	// (we want that to reset whatever formations units are in).
	if (formationTemplate != NULL_FORMATION)
	{
		let formation = ExtractFormations(ents);
		let formationIds = Object.keys(formation.members);
		if (formationIds.length == 1)
		{
			// Selected units either belong to this formation or have no formation.
			let fid = formationIds[0];
			let cmpFormation = Engine.QueryInterface(+fid, IID_Formation);
			if (cmpFormation && cmpFormation.GetMemberCount() == formation.members[fid].length &&
			    cmpFormation.GetMemberCount() == formation.entities.length)
			{
				cmpFormation.DeleteTwinFormations();

				// The whole formation was selected, so reuse its controller for this command.
				if (!forceTemplate || formationTemplate == formation.templates[fid])
				{
					formationTemplate = formation.templates[fid];
					formationUnitAIs = [Engine.QueryInterface(+fid, IID_UnitAI)];
				}
				else if (formationTemplate && CanMoveEntsIntoFormation(formation.entities, formationTemplate))
					formationUnitAIs = [cmpFormation.LoadFormation(formationTemplate)];
			}
			else if (cmpFormation && !forceTemplate)
			{
				// Just reuse the template.
				formationTemplate = formation.templates[fid];
			}
		}
		else if (formationIds.length)
		{
			// Check if all entities share a common formation, if so reuse this template.
			let template = formation.templates[formationIds[0]];
			for (let i = 1; i < formationIds.length; ++i)
				if (formation.templates[formationIds[i]] != template)
				{
					template = null;
					break;
				}
			if (template && !forceTemplate)
				formationTemplate = template;
		}
	}

	// Separate out the units that don't support the chosen formation.
	let formedUnits = [];
	let nonformedUnitAIs = [];
	for (let ent of ents)
	{
		let cmpUnitAI = Engine.QueryInterface(ent, IID_UnitAI);
		let cmpPosition = Engine.QueryInterface(ent, IID_Position);
		if (!cmpUnitAI || !cmpPosition || !cmpPosition.IsInWorld())
			continue;

		let cmpIdentity = Engine.QueryInterface(ent, IID_Identity);
		// TODO: We only check if the formation is usable by some units
		// if we move them to it. We should check if we can use formations
		// for the other cases.
		let nullFormation = (formationTemplate || cmpUnitAI.GetFormationTemplate()) == NULL_FORMATION;
		if (nullFormation || !cmpIdentity || !cmpIdentity.CanUseFormation(formationTemplate || NULL_FORMATION))
		{
			if (nullFormation && cmpUnitAI.GetFormationController())
				cmpUnitAI.LeaveFormation(cmd.queued || false);
			nonformedUnitAIs.push(cmpUnitAI);
		}
		else
			formedUnits.push(ent);
	}
	if (nonformedUnitAIs.length == ents.length)
	{
		// No units support the formation.
		return nonformedUnitAIs;
	}

	if (!formationUnitAIs.length)
	{
		// We need to give the selected units a new formation controller.

		// TODO replace the fixed 60 with something sensible, based on vision range f.e.
		let formationSeparation = 60;
		let clusters = ClusterEntities(formedUnits, formationSeparation);
		let formationEnts = [];
		for (let cluster of clusters)
		{
			RemoveFromFormation(cluster);

			if (!formationTemplate || !CanMoveEntsIntoFormation(cluster, formationTemplate))
			{
				for (let ent of cluster)
					nonformedUnitAIs.push(Engine.QueryInterface(ent, IID_UnitAI));

				continue;
			}

			// Create the new controller.
			let formationEnt = Engine.AddEntity(formationTemplate);
			let cmpFormation = Engine.QueryInterface(formationEnt, IID_Formation);
			formationUnitAIs.push(Engine.QueryInterface(formationEnt, IID_UnitAI));
			cmpFormation.SetFormationSeparation(formationSeparation);
			cmpFormation.SetMembers(cluster);

			for (let ent of formationEnts)
				cmpFormation.RegisterTwinFormation(ent);

			formationEnts.push(formationEnt);
			let cmpOwnership = Engine.QueryInterface(formationEnt, IID_Ownership);
			cmpOwnership.SetOwner(player);
		}
	}

	return nonformedUnitAIs.concat(formationUnitAIs);
}

/**
 * Get some information about the formations used by entities.
 */
function ExtractFormations(ents)
{
	let entities = []; // Entities with UnitAI.
	let members = {}; // { formationentity: [ent, ent, ...], ... }
	let templates = {};  // { formationentity: template }
	for (let ent of ents)
	{
		let cmpUnitAI = Engine.QueryInterface(ent, IID_UnitAI);
		if (!cmpUnitAI)
			continue;

		entities.push(ent);

		let fid = cmpUnitAI.GetFormationController();
		if (fid == INVALID_ENTITY)
			continue;

		if (!members[fid])
		{
			members[fid] = [];
			templates[fid] = cmpUnitAI.GetFormationTemplate();
		}
		members[fid].push(ent);
	}

	return {
		"entities": entities,
		"members": members,
		"templates": templates
	};
}

/**
 * Remove the given list of entities from their current formations.
 */
function RemoveFromFormation(ents)
{
	let formation = ExtractFormations(ents);
	for (let fid in formation.members)
	{
		let cmpFormation = Engine.QueryInterface(+fid, IID_Formation);
		if (cmpFormation)
			cmpFormation.RemoveMembers(formation.members[fid]);
	}
}

/**
 * Group a list of entities in clusters via single-links
 */
function ClusterEntities(ents, separationDistance)
{
	let clusters = [];
	if (!ents.length)
		return clusters;

	let distSq = separationDistance * separationDistance;
	let positions = [];
	// triangular matrix with the (squared) distances between the different clusters
	// the other half is not initialised
	let matrix = [];
	for (let i = 0; i < ents.length; ++i)
	{
		matrix[i] = [];
		clusters.push([ents[i]]);
		let cmpPosition = Engine.QueryInterface(ents[i], IID_Position);
		positions.push(cmpPosition.GetPosition2D());
		for (let j = 0; j < i; ++j)
			matrix[i][j] = positions[i].distanceToSquared(positions[j]);
	}
	while (clusters.length > 1)
	{
		// search two clusters that are closer than the required distance
		let closeClusters = undefined;

		for (let i = matrix.length - 1; i >= 0 && !closeClusters; --i)
			for (let j = i - 1; j >= 0 && !closeClusters; --j)
				if (matrix[i][j] < distSq)
					closeClusters = [i,j];

		// if no more close clusters found, just return all found clusters so far
		if (!closeClusters)
			return clusters;

		// make a new cluster with the entities from the two found clusters
		let newCluster = clusters[closeClusters[0]].concat(clusters[closeClusters[1]]);

		// calculate the minimum distance between the new cluster and all other remaining
		// clusters by taking the minimum of the two distances.
		let distances = [];
		for (let i = 0; i < clusters.length; ++i)
		{
			let a = closeClusters[1];
			let b = closeClusters[0];
			if (i == a || i == b)
				continue;
			let dist1 = matrix[a][i] !== undefined ? matrix[a][i] : matrix[i][a];
			let dist2 = matrix[b][i] !== undefined ? matrix[b][i] : matrix[i][b];
			distances.push(Math.min(dist1, dist2));
		}
		// remove the rows and columns in the matrix for the merged clusters,
		// and the clusters themselves from the cluster list
		clusters.splice(closeClusters[0],1);
		clusters.splice(closeClusters[1],1);
		matrix.splice(closeClusters[0],1);
		matrix.splice(closeClusters[1],1);
		for (let i = 0; i < matrix.length; ++i)
		{
			if (matrix[i].length > closeClusters[0])
				matrix[i].splice(closeClusters[0],1);
			if (matrix[i].length > closeClusters[1])
				matrix[i].splice(closeClusters[1],1);
		}
		// add a new row of distances to the matrix and the new cluster
		clusters.push(newCluster);
		matrix.push(distances);
	}
	return clusters;
}

