// The stub resolver's configuration, the one file under investigation/runner that may name its
// address (the Q-1 ruling, held by runner-boundaries.test.ts). The scanner's guard refuses a target
// whose address it does not read as public before it connects, so the stub must answer with an
// address that reads as public; a documentation-range address would be refused. It is never
// contacted: the scanner's proxy hands each connection it allows to the fixture origin, and the
// container has no network. lib/investigation-seam-setting.test.ts uses the same address for the
// same purpose.
export const STUB_ADDRESS = "93.184.216.34";
export const resolvePublicHost = async () => [{ address: STUB_ADDRESS, family: 4 }];
