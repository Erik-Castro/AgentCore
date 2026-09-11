/**
 * Data:	São Paulo, 11 de Setembro de 20226
 * Nome:	Erik Castro
 * 
 * Descrição:	Objetivo deste é apenas uma rápido planejamento
 * 		de um Agent de IA. o objetivo é um estudo para
 * 		melhoria em no projeto **OllamaTask** disponivel
 * 		em: https://github.com/Erik-Castro/OllamaTask.git
 * 		um agent autonomo para uso de modelos locais, para
 * 		tarefas que podem ser usados por agentes menores
 * ----------------------------------------------------------------
 *
 **/
import OpenAI from "openai";

const BASE_URL = Deno.env.get("OPENAI_BASE_URL") ?? "http://localhost:11434/v1";
const API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "ollama";

const client = new OpenAI({
	baseURL: BASE_URL,
	apiKey: API_KEY,
	maxRetries: 5
});

interface TContent {
	content: string;
	reasoning: string;
}

interface TExecutionResult {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	timeExecution: number;
	content: TContent;
}

interface TAgent {
	model: string;
	thinkinkg: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	system_prompt: string;
	maxRounds: number;
}

const write = (c: string)=> Deno.stdout.writeSync(new TextEncoder().encode(c));

// Planejamento do motor que ficará dentro da classe pricipal
const response = new ReadableStream({
	async start(controller) {
		const rsp = await client.responses.create({
			model: "llama3.4:4b",
			input: _messages,
			stream: true,
		});

		for await (const delta of rsp) {
			switch(delta.type) {
				case "thinking": // exemplo consultar a documentação do SDK
					controller.enqueue(delta.delta);
					break;
				case "thinking.end":
					controller.enqueue("\n");
					break;
				case "content":
					controller.enqueue(delta.delta);
					break;
				case "content.end":
					controller.enqueue("\n");
					break;
			}
		}

	}

	cancler () {// gracefull shutdown and degradation standard}
});


/**
 * Classe principal do loop
 * deverá ocorrer via streaming.
 * */
export class ReAct {
	private _messages = [];
	private _system_prompt: string | undefined;
	private _rounds: number = 0;
	private _callings: number = 0;
	private _maxRounds: number = 6;
	private _think_level: string | undefined;
	private _model: string | undefined;
	private _tools = [];

	contructor(AgentConfig:TAgent) {
		this._system_prompt = AgentConfig.system_prompt;
		this._maxRounds = AgentConfig.maxRounds;
		this._think_level = AgentConfig.thinking;
		this._model = AgentConfig.model;
	}

	public onToolCalling(cb: (name: string, params: string)=> void): void {};
	public onToolResponse(cb: (name: string, reponse: string)=> void):void {};
	public onReasoning(cb: (token: string)=> void): void {};
	public onContent(cb: (token: string)=> void): void {};
	public registryTool(): void {};
	public run(prompt :string): Promise<ExxecutionResult> {};
}
