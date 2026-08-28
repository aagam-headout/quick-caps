#!/usr/bin/env node
const { main } = await import('../dist/cli.js');
await main(process.argv.slice(2));
