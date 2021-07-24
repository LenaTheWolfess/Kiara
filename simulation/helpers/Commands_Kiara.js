g_Commands["walk-to-range"] = function(player, cmd, data)
{
	// Only used by the AI
	for (let ent of data.entities)
	GetFormationUnitAIs([data.entities[ent]], player, cmd, data.formation).forEach(cmpUnitAI => {
		cmpUnitAI.WalkToPointRange(cmd.x, cmd.z, cmd.min, cmd.max, cmd.queued);
	});
};

g_Commands["regroup"] = function(player, cmd, data)
{
	GetFormationUnitAIs(data.entities, player, cmd, data.formation, true).forEach(cmpUnitAI => {
		cmpUnitAI.MoveIntoFormation(cmd);
	});
};