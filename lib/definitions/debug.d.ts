
interface IPlatformDebugService {
	getDebugger(platform: string): IDebugService;
}

interface IDebugService {
	debug(): IFuture<void>;
}
