# D3.6B swap action profile

`onchaindiligence.swap-action.v1` is a portable signed artifact for one deliberately narrow action: a direct Base `SwapRouter02` `exactInputSingle` call from canonical USDC to Base WETH. It requires the payer, beneficiary, maximum input, minimum output, and the official Base router address.

The observer decodes the direct router calldata, reconstructs one USDC outbound transfer from the payer and one WETH inbound transfer to the decoded beneficiary, then records Base safe-head finality. Multicalls, aggregators, multi-hop routes, native/wrapped boundaries beyond Base WETH, fee-on-transfer shapes, and ambiguous transfer sets are reported as unsupported/evidence gaps rather than guessed.

`ALLOW` is a policy decision only. A valid artifact proves integrity and issuance under OCD's signing key; it does not prove price fairness, safety, delivery, or objective truth.
