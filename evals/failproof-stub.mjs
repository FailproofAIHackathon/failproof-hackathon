// Minimal stand-in for the "failproofai" package so the REAL policy file can be loaded by the eval runner.
export const registered = [];
export const customPolicies = { add: (p) => registered.push(p) };
export const allow = () => ({ decision: "allow" });
export const deny = (message) => ({ decision: "deny", message });
export const instruct = (message) => ({ decision: "instruct", message });
