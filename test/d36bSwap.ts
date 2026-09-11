import assert from 'node:assert/strict'
import { evaluateSwapPolicy, parseSwapInput, BASE_WETH, UNISWAP_V3_SWAP_ROUTER02_BASE } from '../src/swap.js'
import { deriveSwapFindings } from '../src/swapEvidence.js'
import { inspectPayment } from '../src/preflight.js'
const PAYER='0x1111111111111111111111111111111111111111', RECIPIENT='0x2222222222222222222222222222222222222222', USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', TX=`0x${'ab'.repeat(32)}`, BLOCK=`0x${'cd'.repeat(32)}`
const input={action:{kind:'SWAP',network:'eip155:8453',input_asset:USDC,max_input_atomic:'100000000',output_asset:BASE_WETH,min_output_atomic:'50000000000000000',recipient:RECIPIENT,router:UNISWAP_V3_SWAP_ROUTER02_BASE,deadline:null,payer:PAYER},policy:{allowed_networks:['eip155:8453'],allowed_input_assets:[USDC],allowed_output_assets:[BASE_WETH],allowed_routers:[UNISWAP_V3_SWAP_ROUTER02_BASE],max_input_atomic:'100000000',min_output_atomic:'50000000000000000',exact_recipient:RECIPIENT}}
const parsed=parseSwapInput(input);assert.equal(evaluateSwapPolicy(parsed).decision.status,'ALLOW')
const o:any={state:'success',network:'eip155:8453',transaction_hash:TX,router:UNISWAP_V3_SWAP_ROUTER02_BASE,payer:PAYER,decoded_parameters:{input_asset:USDC,output_asset:BASE_WETH,recipient:RECIPIENT,max_input_atomic:'99800000',min_output_atomic:'50000000000000000'},input_transfer:{token:USDC,from:PAYER,to:'0x3333333333333333333333333333333333333333',amount_atomic:'99800000',log_index:1,transaction_hash:TX,block_hash:BLOCK},output_transfer:{token:BASE_WETH,from:'0x3333333333333333333333333333333333333333',to:RECIPIENT,amount_atomic:'51000000000000000',log_index:2,transaction_hash:TX,block_hash:BLOCK},block_number:'1',block_hash:BLOCK,finality:{state:'safe'},rpc_error:null}
assert.equal(deriveSwapFindings(parsed.action,o).length,0)
assert.equal(deriveSwapFindings(parsed.action,{...o,router:PAYER})[0].code,'ROUTER_MISMATCH')
assert.ok(deriveSwapFindings(parsed.action,{...o,output_transfer:{...o.output_transfer,amount_atomic:'1'}}).some(x=>x.code==='MINIMUM_OUTPUT_NOT_MET'))
assert.ok(deriveSwapFindings(parsed.action,{...o,decoded_parameters:{...o.decoded_parameters,recipient:PAYER}}).some(x=>x.code==='RECIPIENT_MISMATCH'))
assert.ok(deriveSwapFindings(parsed.action,{...o,decoded_parameters:{...o.decoded_parameters,output_asset:USDC}}).some(x=>x.code==='OUTPUT_ASSET_MISMATCH'))
assert.equal(deriveSwapFindings(parsed.action,{...o,state:'unsupported-shape',finality:null})[0].finding_class,'INSUFFICIENT_EVIDENCE')
assert.equal((await inspectPayment({action:{kind:'PAYMENT',resource:null,network:'eip155:8453',asset:USDC,amount:'1',sender:null,recipient:RECIPIENT},policy:{max_amount:'1'}})).decision.status,'ALLOW')
console.log('D3.6B swap tests passed')
