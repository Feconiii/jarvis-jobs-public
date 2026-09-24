// Printed at the end of `npm run jarvis:test`, because a green fast suite is
// not the same as "the tests pass" and I asserted otherwise three times (F-282).
//
// The end-to-end run is deliberately not in the fast suite: it takes ninety
// seconds, needs the network, and needs a live posting in his queue. That is a
// good reason to keep it separate and no reason at all to forget it — two
// security fixes in one session broke a test in that file, and only running it
// found out.
console.log(`
  This run did NOT include the end-to-end test — network, a live posting, ~90s.
  Touched the extension, the token gate, or a server contract?

      npm run jarvis:test:all
`);
