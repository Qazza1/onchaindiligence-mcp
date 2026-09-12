/** Strict Base USDC -> WETH, direct Uniswap V3 SwapRouter02 authorization. */
import { randomBytes } from 'node:crypto'
import { BASE_CAIP2, BASE_USDC } from './settlementNetworks.js'

export const SWAP_ACTION_SCHEMA = 'onchaindiligence.swap-action.v1'
export const SWAP_ATTESTATION_PURPOSE = 'swap-action'
export const UNISWAP_V3_SWAP_ROUTER02_BASE = '0x2626664c2603336e57b271c5c0b26f421741e481'
export const BASE_WETH = '0x4200000000000000000000000000000000000006'
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const ATOMIC = /^(0|[1-9][0-9]*)$/
const address = (v: unknown, n: string) => { if (typeof v !== 'string' || !ADDRESS.test(v)) throw new SwapInputError(`${n} must be an EVM address`); return v.toLowerCase() }
const atomic = (v: unknown, n: string) => { if (typeof v !== 'string' || !ATOMIC.test(v)) throw new SwapInputError(`${n} must be a canonical non-negative atomic decimal string`); return v }
const obj = (v: unknown, n: string): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SwapInputError(`${n} must be an object`); return v as Record<string, unknown> }
const reject = (o: Record<string, unknown>, keys: string[], n: string) => { for (const k of Object.keys(o)) if (!keys.includes(k)) throw new SwapInputError(`${n} has an unexpected field: ${k}`) }
export class SwapInputError extends Error {}
export type SwapDecision = 'ALLOW'|'REQUIRE_APPROVAL'|'BLOCK'|'UNKNOWN'
export interface SwapAction { kind:'SWAP'; network:typeof BASE_CAIP2; input_asset:typeof BASE_USDC; max_input_atomic:string; output_asset:typeof BASE_WETH; min_output_atomic:string; recipient:string; router:typeof UNISWAP_V3_SWAP_ROUTER02_BASE; deadline:string|null; payer:string }
export interface SwapPolicy { allowed_networks:string[]|null; allowed_input_assets:string[]|null; allowed_output_assets:string[]|null; allowed_routers:string[]|null; max_input_atomic:string|null; min_output_atomic:string|null; exact_recipient:string|null }
export interface SwapCheck { id:string; result:'PASS'|'FAIL'; summary:string }
export interface ParsedSwap { action:SwapAction; policy:SwapPolicy }
export function parseSwapInput(raw: unknown): ParsedSwap {
 const body=obj(raw,'body'); reject(body,['action','policy'],'body'); const a=obj(body.action,'action'); reject(a,['kind','network','input_asset','max_input_atomic','output_asset','min_output_atomic','recipient','router','deadline','payer'],'action')
 if(a.kind!=='SWAP') throw new SwapInputError('action.kind must be "SWAP"')
 if(a.network!==BASE_CAIP2) throw new SwapInputError(`swap observation currently supports only ${BASE_CAIP2}`)
 const action:SwapAction={kind:'SWAP',network:BASE_CAIP2,input_asset:address(a.input_asset,'action.input_asset') as typeof BASE_USDC,max_input_atomic:atomic(a.max_input_atomic,'action.max_input_atomic'),output_asset:address(a.output_asset,'action.output_asset') as typeof BASE_WETH,min_output_atomic:atomic(a.min_output_atomic,'action.min_output_atomic'),recipient:address(a.recipient,'action.recipient'),router:address(a.router,'action.router') as typeof UNISWAP_V3_SWAP_ROUTER02_BASE,deadline:a.deadline===undefined||a.deadline===null?null:atomic(a.deadline,'action.deadline'),payer:address(a.payer,'action.payer')}
 if(action.input_asset!==BASE_USDC||action.output_asset!==BASE_WETH||action.router!==UNISWAP_V3_SWAP_ROUTER02_BASE) throw new SwapInputError('only direct Base canonical-USDC to Base-WETH via Uniswap V3 SwapRouter02 is supported')
 if(BigInt(action.max_input_atomic)===0n||BigInt(action.min_output_atomic)===0n) throw new SwapInputError('max_input_atomic and min_output_atomic must be greater than zero')
 const p=obj(body.policy,'policy'); reject(p,['allowed_networks','allowed_input_assets','allowed_output_assets','allowed_routers','max_input_atomic','min_output_atomic','exact_recipient','acknowledge_unconstrained'],'policy')
 const list=(v:unknown,n:string)=>v===undefined||v===null?null:(Array.isArray(v)&&v.every(x=>typeof x==='string')?v.map(x=>x.toLowerCase()):(()=>{throw new SwapInputError(`${n} must be an array of strings or null`)})())
 const policy:SwapPolicy={allowed_networks:list(p.allowed_networks,'policy.allowed_networks'),allowed_input_assets:list(p.allowed_input_assets,'policy.allowed_input_assets'),allowed_output_assets:list(p.allowed_output_assets,'policy.allowed_output_assets'),allowed_routers:list(p.allowed_routers,'policy.allowed_routers'),max_input_atomic:p.max_input_atomic===undefined||p.max_input_atomic===null?null:atomic(p.max_input_atomic,'policy.max_input_atomic'),min_output_atomic:p.min_output_atomic===undefined||p.min_output_atomic===null?null:atomic(p.min_output_atomic,'policy.min_output_atomic'),exact_recipient:p.exact_recipient===undefined||p.exact_recipient===null?null:address(p.exact_recipient,'policy.exact_recipient')}
 if(!Object.values(policy).some(v=>v!==null)&&p.acknowledge_unconstrained!==true) throw new SwapInputError('policy has no constraints; set acknowledge_unconstrained: true only when intentional')
 return {action,policy}
}
export function evaluateSwapPolicy(input:ParsedSwap) { const {action:a,policy:p}=input; const checks:SwapCheck[]=[]; const fail=(id:string,ok:boolean,s:string)=>checks.push({id,result:ok?'PASS':'FAIL',summary:s}); if(p.allowed_networks)fail('network-allowed',p.allowed_networks.includes(a.network),'Network is within policy.'); if(p.allowed_input_assets)fail('input-asset-allowed',p.allowed_input_assets.includes(a.input_asset),'Input asset is within policy.'); if(p.allowed_output_assets)fail('output-asset-allowed',p.allowed_output_assets.includes(a.output_asset),'Output asset is within policy.'); if(p.allowed_routers)fail('router-allowed',p.allowed_routers.includes(a.router),'Router is within policy.'); if(p.max_input_atomic!==null)fail('maximum-input',BigInt(a.max_input_atomic)<=BigInt(p.max_input_atomic),'Maximum input is within policy.'); if(p.min_output_atomic!==null)fail('minimum-output',BigInt(a.min_output_atomic)>=BigInt(p.min_output_atomic),'Minimum output meets policy.'); if(p.exact_recipient!==null)fail('recipient-exact',a.recipient===p.exact_recipient,'Recipient matches policy.'); const failed=checks.filter(c=>c.result==='FAIL'); return {decision:{status:failed.length?'BLOCK' as SwapDecision:'ALLOW' as SwapDecision,authorized:failed.length?false:true,reasons:failed.length?failed.map(x=>x.summary):['All configured swap policy checks passed. OCD does not authorize wallet execution.']},checks} }
export const generateSwapOperationId=()=>`OCD-SWP-${randomBytes(20).toString('base64url')}`
