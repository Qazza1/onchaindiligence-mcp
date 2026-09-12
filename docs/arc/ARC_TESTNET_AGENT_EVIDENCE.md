# Arc Testnet agent evidence — D3.5C3-PRE

Observed on 2026-09-12 through the official Arc Testnet RPC, `https://rpc.testnet.arc.io`. Network: `eip155:5042002`. Explorer links below are public. This is Testnet evidence only.

## ERC-8004 identity

- Agent: `OnChainDiligence Verification Agent`
- Agent ID: `894557`
- Owner: `0xb8624E695C361F0c54F61B465dd15AF63C2c5D8E`
- IdentityRegistry: `0x8004A818BFB912233c491871b3d84c89A494BD9e`
- Immutable metadata URI: `https://raw.githubusercontent.com/Qazza1/onchaindiligence-mcp/1500d781b6262e7d963a382d100233a991bc4c75/docs/arc/onchaindiligence-verification-agent.json`
- Registration transaction: [`0x6a4ff1…f51d32`](https://testnet.arcscan.app/tx/0x6a4ff1cedacdcdc4868d4ae7432acf99f67754ac01c1bf00f029917f12f51d32)
- Block: `61748735`
- Block hash: `0x3b8a662c8bdc9921fd6f26738256e924f3b9a1f2a6399193ff051dae651f3d53`

Independent `ownerOf(894557)` and `tokenURI(894557)` reads returned the owner and immutable URI above.

## Controlled ERC-8004 validation

Claim: “Verify that the registered OnChainDiligence Verification Agent metadata is readable and its owner matches the expected Arc Testnet owner at the observed chain state.”

- Validator: `0xF8Ce4187870aB0517d44E5CE59B35698dE182f19`
- Tag: `ocd_testnet_observer_reachable`
- Request artifact: immutable commit `848e6c8d61bb0812dea3fefd048d9285fe6dc37e`
- Request hash: `0x77e3c7cc28e218628c0386da6942b085041acb3f2353bf0d74609cd98d88e808`
- Request transaction: [`0xb481cc…fa243`](https://testnet.arcscan.app/tx/0xb481cca687a716d99e87f6a6346612a25b6022f78174002caf78375ca02fa243)
- Request block/hash: `61748891` / `0x70e9ed86d16833ae53700b012017f06764ff744f73152a26dc6ecc20f558a8dc`
- Validator observation block/hash: `61748949` / `0xe9f0eaa6d5778b3aa296cbd62a31014bc73828faba2f5d2480912b9fb4597ca9`
- Response artifact: immutable commit `03dd1e419ff505be148606d020beaa45de69c343`
- Response hash: `0x8f41c90c7db51a0f5eca90f9096c81084f00182356e481280b069e33e0a5d2ee`
- Response transaction: [`0x4f9678…676bc0`](https://testnet.arcscan.app/tx/0x4f9678934e2391558e1c14944d4e1b8ee94b237eacc20683d7c4948a2a676bc0)
- Response block/hash: `61749097` / `0xd2a028135eeb2d8552bd9787a68723e0142d7e4fb47828bdc48670446492beb4`
- Raw `getValidationStatus`: validator above; agent ID `894557`; response `100`; response hash above; tag above; `lastUpdate=1789226198`.

The validator first read the identity registry, compared the owner and immutable metadata URI, and fetched the metadata successfully. Response `100` records only that narrow ERC-8004 registry assertion. It is **not** an OnChainDiligence `VALID` result and does not establish safety, compliance, broader capability, or service delivery.

## ERC-8004 reputation

Read-only `getClients(894557)` returned an empty list. No feedback was created. This is an honest absence of reputation evidence, not a positive or negative reputation result.

## Historical ERC-8183 observation

The observer located and read an existing public job:

- Job ID: `186160`
- Contract: `0x0747EEf0706327138c69792bF28Cd525089e4583`
- Created transaction: [`0x5cf32c…dba08`](https://testnet.arcscan.app/tx/0x5cf32c75f05ffc628a9059ff5a50150bf36b771c2da7e9ea6c6503b01a4dba08)
- Created block/hash: `61740146` / `0x48abee929505e63f18e5a800634affd028c646fc9c2e8574839f1ef52b145e19`
- Client/evaluator: `0x2F061aA574882C84649230b475a44D35795cC018`
- Provider: `0xB152c3B6436318aD340153f1d30C9BBb8634681A`
- Description: `ERC-8183 demo job on Arc Testnet`
- Budget: `1.000000 USDC`
- Raw/friendly status: `3` / `Completed`

This is a public contract-state observation. `Completed` is evaluator-driven protocol state, not independent proof of real-world service delivery.

## Controlled ERC-8183 lifecycle

One test-only lifecycle used an intentional escrow of exactly `100000` base units (`0.10 USDC`), with the owner as client/evaluator and the separate provider wallet as provider. No external paid service was used.

- Job ID: `186165`
- State reads: `Open` after creation; `Open` with budget `100000`; `Funded`; `Submitted`; `Completed`.
- Deliverable hash: `0xfab7a7c4f8988fc4bdba7380a35c0a9159942a87707a4515688db1815aed576a`
- Completion-reason hash: `0x68ed05f2341be0935cf7509e97a526b74e1c622ea700fd5905165c7ceaf619e5`

| Action | Transaction | Block | Block hash |
| --- | --- | ---: | --- |
| Create job | [`0xf0aa8b…8f25e7`](https://testnet.arcscan.app/tx/0xf0aa8b505076b30bc8778dccaf2876fde22efb596259d3f002a7db436b8f25e7) | 61749374 | `0xcd64df161f7b1494cf03404720173d691bf11f0f97c4891f638eeffc4bec1607` |
| Set budget | [`0x2d1f5b…b2685e`](https://testnet.arcscan.app/tx/0x2d1f5bf0c756764291bcdac987983418c57c555705a51db2748593b85eb2685e) | 61749382 | `0x760aad3ab221fae1fe678a7a97767cc1cb60b8979ddda07ecd2b444f271c947a` |
| Approve | [`0x274e61…d1bb8`](https://testnet.arcscan.app/tx/0x274e61acfa06a50bcb282dd20d7fcad720321a27bbaf9f0cb530ff44050d1bb8) | 61749391 | `0x74d55b50d8a64845dc1a5a8a12b86ca3d4066e68a7d804870dcd6299d153b0b7` |
| Fund | [`0xb24537…13db4`](https://testnet.arcscan.app/tx/0xb24537debb0df68ed5412a218cc9aadac7fd04ea6f52e1a9d1c727fd98513db4) | 61749400 | `0xf04b0f3827178c648f29d85505ccac2bdac973f4c42d781bbd5d1658d636d3e2` |
| Submit | [`0x6c3a91…6a045a`](https://testnet.arcscan.app/tx/0x6c3a912494bc62a4f298e7e9c1f08c4a6fc8a364b5e7cf2d49cf746e956a045a) | 61749408 | `0xfcd7d6388d0c4a5efa52f42746f1833a0361a426bfa06eb16d662fe469c23109` |
| Complete | [`0xde2e25…99cdc1`](https://testnet.arcscan.app/tx/0xde2e25aea7f94ca2b111a5d9b6f24738608d7892505bbf5e54c70e1edb99cdc1) | 61749417 | `0x205a80a8b5a2d3de4bbd19011e402f4def897c0730743e1ff3afb62d3bf907a2` |

Total gas across registration, validation and this lifecycle was `26021600000000000` native base units (`0.0260216` at 18-decimal display precision). The intentional escrow transfer was `0.10 USDC`; it moved to the provider on evaluator completion. These Testnet values have no production or customer-payment meaning.

As with the historical job, `Completed` is the configured evaluator's ERC-8183 decision and settlement transition. It is not independent proof that any real-world service was delivered.
