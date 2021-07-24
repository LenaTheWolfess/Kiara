var API3 = function(m)
{

m.error = function(output)
{
	if (typeof output === "string")
		error("PlayerID " + PlayerID + " |   " + output);
	else
		error("PlayerID " + PlayerID + " |   " + uneval(output));
}

return m;

}(API3);
