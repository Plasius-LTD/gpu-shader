declare module "wgsl_reflect/wgsl_reflect.module.js" {
  export class WgslReflect {
    constructor(code?: string);
    uniforms: any[];
    storage: any[];
    textures: any[];
    samplers: any[];
    overrides: any[];
    structs: any[];
    entry: { vertex: any[]; fragment: any[]; compute: any[] };
  }

  export class WgslParser {
    static Parse(code: string): any[];
  }
  export class Var { [key: string]: any }
  export class Const { [key: string]: any }
  export class Let { [key: string]: any }
  export class Override { [key: string]: any }
  export class Struct { [key: string]: any }
  export class Function { [key: string]: any }
}
