import { SIGNUP_PATH } from './config';
import { contactText, overviewText, plansText, signupText, faqText } from './agentes';

/**
 * WebMCP: ferramentas da landing para assistentes de IA no navegador
 * (navigator.modelContext.registerTool). Só navegação e informação pública do produto; nada do
 * painel. Script em linha, para registrar as ferramentas no carregamento da página (antes da
 * hidratação). Em navegador sem WebMCP, não faz nada.
 */
export function webMcpScript(): string {
  const data = {
    sobre: overviewText(),
    planos: plansText(),
    conta: signupText(),
    contato: contactText(),
    perguntas: faqText(),
    signup: SIGNUP_PATH,
  };
  // JSON dentro de <script>: "<" escapado para não fechar a tag.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `(function(){var D=${json};var done=false;
function txt(t){return{content:[{type:"text",text:t}]}}
function go(id){var el=id&&document.getElementById(id);if(el){el.scrollIntoView({behavior:"smooth",block:"start"})}else{window.scrollTo({top:0,behavior:"smooth"})}}
var NONE={type:"object",properties:{},additionalProperties:false};
var tools=[
{name:"sobre_o_cenario_gestao",description:"O que é o Cenário Gestão (sistema de gestão para tapeçarias), para quem é e o que faz.",inputSchema:NONE,annotations:{readOnlyHint:true},execute:function(){return txt(D.sobre)}},
{name:"ver_planos",description:"Mostra os planos e preços do Cenário Gestão e rola a página até a mensalidade.",inputSchema:NONE,annotations:{readOnlyHint:true},execute:function(){go("mensalidade");return txt(D.planos)}},
{name:"perguntas_frequentes",description:"Respostas às perguntas mais comuns sobre o Cenário Gestão.",inputSchema:NONE,annotations:{readOnlyHint:true},execute:function(){return txt(D.perguntas)}},
{name:"ir_para_secao",description:"Rola a página até uma parte da landing: topo, planos ou contato.",inputSchema:{type:"object",properties:{secao:{type:"string",enum:["topo","planos","contato"],description:"Parte da página"}},required:["secao"],additionalProperties:false},annotations:{readOnlyHint:true},execute:function(a){var s=a&&a.secao;go(s==="planos"?"mensalidade":s==="contato"?"contato":"");return txt("Página na parte: "+(s||"topo"))}},
{name:"abrir_criar_conta",description:"Abre a tela de Criar conta do Cenário Gestão (a pessoa informa e-mail e senha). Não cria nada sozinho.",inputSchema:NONE,execute:function(){setTimeout(function(){window.location.assign(D.signup)},50);return txt(D.conta)}},
{name:"falar_com_a_equipe",description:"Contato da equipe da Cenário Estofados (link do WhatsApp).",inputSchema:NONE,annotations:{readOnlyHint:true},execute:function(){return txt(D.contato)}}
];
function reg(){var mc=navigator.modelContext;if(done||!mc||typeof mc.registerTool!=="function")return;done=true;
var ctrl=new AbortController();var handles=[];
tools.forEach(function(t){try{var h=mc.registerTool(t,{signal:ctrl.signal});if(h&&typeof h.unregister==="function")handles.push(h)}catch(e){}});
ctrl.signal.addEventListener("abort",function(){handles.forEach(function(h){try{h.unregister()}catch(e){}})});
window.addEventListener("pagehide",function(){ctrl.abort()},{once:true});}
reg();if(!done){document.addEventListener("DOMContentLoaded",reg);window.addEventListener("load",reg)}})();`;
}

export function WebMcpTools() {
  return <script id="webmcp-tools" dangerouslySetInnerHTML={{ __html: webMcpScript() }} />;
}
