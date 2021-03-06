/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {AotCompilerHost, AotCompilerOptions, AotSummaryResolver, CompileDirectiveMetadata, CompileIdentifierMetadata, CompileMetadataResolver, CompileNgModuleMetadata, CompilePipeSummary, CompileTypeMetadata, CompilerConfig, DEFAULT_INTERPOLATION_CONFIG, DirectiveNormalizer, DirectiveResolver, DomElementSchemaRegistry, HtmlParser, I18NHtmlParser, Lexer, NgModuleResolver, ParseError, Parser, PipeResolver, StaticReflector, StaticSymbol, StaticSymbolCache, StaticSymbolResolver, TemplateParser, TypeScriptEmitter, analyzeNgModules, createAotUrlResolver, templateSourceUrl} from '@angular/compiler';
import {ViewEncapsulation} from '@angular/core';
import * as ts from 'typescript';

import {NgAnalyzedModules} from '../../src/aot/compiler';
import {ConstantPool} from '../../src/constant_pool';
import {ParserError} from '../../src/expression_parser/ast';
import * as o from '../../src/output/output_ast';
import {ModuleKind, compileModuleBackPatch} from '../../src/render3/r3_back_patch_compiler';
import {compileModuleFactory} from '../../src/render3/r3_module_factory_compiler';
import {compilePipe} from '../../src/render3/r3_pipe_compiler';
import {OutputMode} from '../../src/render3/r3_types';
import {compileComponent, compileDirective} from '../../src/render3/r3_view_compiler';
import {BindingParser} from '../../src/template_parser/binding_parser';
import {OutputContext} from '../../src/util';
import {MockAotCompilerHost, MockCompilerHost, MockData, MockDirectory, arrayToMockDir, expectNoDiagnostics, settings, setup, toMockFileArray} from '../aot/test_util';

const IDENTIFIER = /[A-Za-z_$ɵ][A-Za-z0-9_$]*/;
const OPERATOR =
    /!|%|\*|\/|\^|\&|\&\&\|\||\|\||\(|\)|\{|\}|\[|\]|:|;|\.|<|<=|>|>=|=|==|===|!=|!==|=>|\+|\+\+|-|--|@|,|\.|\.\.\./;
const STRING = /\'[^'\n]*\'|"[^'\n]*"|`[^`]*`/;
const NUMBER = /[0-9]+/;
const ELLIPSIS = '…';
const TOKEN = new RegExp(
    `^((${IDENTIFIER.source})|(${OPERATOR.source})|(${STRING.source})|${NUMBER.source}|${ELLIPSIS})`);
const WHITESPACE = /^\s+/;

type Piece = string | RegExp;

const IDENT = /[A-Za-z$_][A-Za-z0-9$_]*/;
const SKIP = /(?:.|\n|\r)*/;
const MATCHING_IDENT = /^\$.*\$$/;

function tokenize(text: string): Piece[] {
  function matches(exp: RegExp): string|false {
    const m = text.match(exp);
    if (!m) return false;
    text = text.substr(m[0].length);
    return m[0];
  }
  function next(): string {
    const result = matches(TOKEN);
    if (!result) {
      throw Error(`Invalid test, no token found for '${text.substr(0, 30)}...'`);
    }
    matches(WHITESPACE);
    return result;
  }

  const pieces: Piece[] = [];
  matches(WHITESPACE);
  while (text) {
    const token = next();
    if (token === 'IDENT') {
      pieces.push(IDENT);
    } else if (token === ELLIPSIS) {
      pieces.push(SKIP);
    } else {
      pieces.push(token);
    }
  }
  return pieces;
}

const contextWidth = 100;
export function expectEmit(source: string, emitted: string, description: string) {
  const pieces = tokenize(emitted);
  const expr = r(...pieces);
  if (!expr.test(source)) {
    let last: number = 0;
    for (let i = 1; i < pieces.length; i++) {
      const t = r(...pieces.slice(0, i));
      const m = source.match(t);
      const expected = pieces[i - 1] == IDENT ? '<IDENT>' : pieces[i - 1];
      if (!m) {
        const contextPieceWidth = contextWidth / 2;
        fail(
            `${description}: Expected to find ${expected} '${source.substr(0,last)}[<---HERE expected "${expected}"]${source.substr(last)}'`);
        return;
      } else {
        last = (m.index || 0) + m[0].length;
      }
    }
    fail(
        `Test helper failure: Expected expression failed but the reporting logic could not find where it failed in: ${source}`);
  }
}

const IDENT_LIKE = /^[a-z][A-Z]/;
const SPECIAL_RE_CHAR = /\/|\(|\)|\||\*|\+|\[|\]|\{|\}|\$/g;
function r(...pieces: (string | RegExp)[]): RegExp {
  const results: string[] = [];
  let first = true;
  let group = 0;

  const groups = new Map<string, number>();
  for (const piece of pieces) {
    if (!first)
      results.push(`\\s${typeof piece === 'string' && IDENT_LIKE.test(piece) ? '+' : '*'}`);
    first = false;
    if (typeof piece === 'string') {
      if (MATCHING_IDENT.test(piece)) {
        const matchGroup = groups.get(piece);
        if (!matchGroup) {
          results.push('(' + IDENT.source + ')');
          const newGroup = ++group;
          groups.set(piece, newGroup);
        } else {
          results.push(`\\${matchGroup}`);
        }
      } else {
        results.push(piece.replace(SPECIAL_RE_CHAR, s => '\\' + s));
      }
    } else {
      results.push('(?:' + piece.source + ')');
    }
  }
  return new RegExp(results.join(''));
}

function doCompile(
    data: MockDirectory, angularFiles: MockData, options: AotCompilerOptions = {},
    errorCollector: (error: any, fileName?: string) => void = error => { throw error; },
    compileAction: (
        outputCtx: OutputContext, analyzedModules: NgAnalyzedModules,
        resolver: CompileMetadataResolver, htmlParser: HtmlParser, templateParser: TemplateParser,
        hostBindingParser: BindingParser, reflector: StaticReflector) => void) {
  const testFiles = toMockFileArray(data);
  const scripts = testFiles.map(entry => entry.fileName);
  const angularFilesArray = toMockFileArray(angularFiles);
  const files = arrayToMockDir([...testFiles, ...angularFilesArray]);
  const mockCompilerHost = new MockCompilerHost(scripts, files);
  const compilerHost = new MockAotCompilerHost(mockCompilerHost);

  const program = ts.createProgram(scripts, {...settings}, mockCompilerHost);
  expectNoDiagnostics(program);

  // TODO(chuckj): Replace with a variant of createAotCompiler() when the r3_view_compiler is
  // integrated
  const translations = options.translations || '';

  const urlResolver = createAotUrlResolver(compilerHost);
  const symbolCache = new StaticSymbolCache();
  const summaryResolver = new AotSummaryResolver(compilerHost, symbolCache);
  const symbolResolver = new StaticSymbolResolver(compilerHost, symbolCache, summaryResolver);
  const staticReflector =
      new StaticReflector(summaryResolver, symbolResolver, [], [], errorCollector);
  const htmlParser = new I18NHtmlParser(
      new HtmlParser(), translations, options.i18nFormat, options.missingTranslation, console);
  const config = new CompilerConfig({
    defaultEncapsulation: ViewEncapsulation.Emulated,
    useJit: false,
    missingTranslation: options.missingTranslation,
    preserveWhitespaces: options.preserveWhitespaces,
    strictInjectionParameters: options.strictInjectionParameters,
  });
  const normalizer = new DirectiveNormalizer(
      {get: (url: string) => compilerHost.loadResource(url)}, urlResolver, htmlParser, config);
  const expressionParser = new Parser(new Lexer());
  const elementSchemaRegistry = new DomElementSchemaRegistry();
  const templateParser = new TemplateParser(
      config, staticReflector, expressionParser, elementSchemaRegistry, htmlParser, console, []);
  const resolver = new CompileMetadataResolver(
      config, htmlParser, new NgModuleResolver(staticReflector),
      new DirectiveResolver(staticReflector), new PipeResolver(staticReflector), summaryResolver,
      elementSchemaRegistry, normalizer, console, symbolCache, staticReflector, errorCollector);



  // Create the TypeScript program
  const sourceFiles = program.getSourceFiles().map(sf => sf.fileName);

  // Analyze the modules
  // TODO(chuckj): Eventually this should not be necessary as the ts.SourceFile should be sufficient
  // to generate a template definition.
  const analyzedModules = analyzeNgModules(sourceFiles, compilerHost, symbolResolver, resolver);

  const pipesOrDirectives = Array.from(analyzedModules.ngModuleByPipeOrDirective.keys());

  const fakeOutputContext: OutputContext = {
    genFilePath: 'fakeFactory.ts',
    statements: [],
    importExpr(symbol: StaticSymbol, typeParams: o.Type[]) {
      if (!(symbol instanceof StaticSymbol)) {
        if (!symbol) {
          throw new Error('Invalid: undefined passed to as a symbol');
        }
        throw new Error(`Invalid: ${(symbol as any).constructor.name} is not a symbol`);
      }
      return (symbol.members || [])
          .reduce(
              (expr, member) => expr.prop(member),
              <o.Expression>o.importExpr(new o.ExternalReference(symbol.filePath, symbol.name)));
    },
    constantPool: new ConstantPool()
  };

  const errors: ParseError[] = [];

  const hostBindingParser = new BindingParser(
      expressionParser, DEFAULT_INTERPOLATION_CONFIG, elementSchemaRegistry, [], errors);

  // Load all directives and pipes
  for (const pipeOrDirective of pipesOrDirectives) {
    const module = analyzedModules.ngModuleByPipeOrDirective.get(pipeOrDirective) !;
    resolver.loadNgModuleDirectiveAndPipeMetadata(module.type.reference, true);
  }

  compileAction(
      fakeOutputContext, analyzedModules, resolver, htmlParser, templateParser, hostBindingParser,
      staticReflector);

  fakeOutputContext.statements.unshift(...fakeOutputContext.constantPool.statements);

  const emitter = new TypeScriptEmitter();

  const moduleName = compilerHost.fileNameToModuleName(
      fakeOutputContext.genFilePath, fakeOutputContext.genFilePath);

  const result = emitter.emitStatementsAndContext(
      fakeOutputContext.genFilePath, fakeOutputContext.statements, '', false,
      /* referenceFilter */ undefined,
      /* importFilter */ e => e.moduleName != null && e.moduleName.startsWith('/app'));

  if (errors.length) {
    throw new Error('Unexpected errors:' + errors.map(e => e.toString()).join(', '));
  }

  return {source: result.sourceText, outputContext: fakeOutputContext};
}

export function compile(
    data: MockDirectory, angularFiles: MockData, options: AotCompilerOptions = {},
    errorCollector: (error: any, fileName?: string) => void = error => { throw error;}) {
  return doCompile(
      data, angularFiles, options, errorCollector,
      (outputCtx: OutputContext, analyzedModules: NgAnalyzedModules,
       resolver: CompileMetadataResolver, htmlParser: HtmlParser, templateParser: TemplateParser,
       hostBindingParser: BindingParser, reflector: StaticReflector) => {
        const pipesOrDirectives = Array.from(analyzedModules.ngModuleByPipeOrDirective.keys());
        for (const pipeOrDirective of pipesOrDirectives) {
          const module = analyzedModules.ngModuleByPipeOrDirective.get(pipeOrDirective);
          if (!module || !module.type.reference.filePath.startsWith('/app')) {
            continue;
          }
          if (resolver.isDirective(pipeOrDirective)) {
            const metadata = resolver.getDirectiveMetadata(pipeOrDirective);
            if (metadata.isComponent) {
              const fakeUrl = 'ng://fake-template-url.html';
              const htmlAst = htmlParser.parse(metadata.template !.template !, fakeUrl);

              const directives = module.transitiveModule.directives.map(
                  dir => resolver.getDirectiveSummary(dir.reference));
              const pipes = module.transitiveModule.pipes.map(
                  pipe => resolver.getPipeSummary(pipe.reference));
              const parsedTemplate = templateParser.parse(
                  metadata, htmlAst, directives, pipes, module.schemas, fakeUrl, false);
              compileComponent(
                  outputCtx, metadata, pipes, parsedTemplate.template, reflector, hostBindingParser,
                  OutputMode.PartialClass);
            } else {
              compileDirective(
                  outputCtx, metadata, reflector, hostBindingParser, OutputMode.PartialClass);
            }
          } else if (resolver.isPipe(pipeOrDirective)) {
            const metadata = resolver.getPipeMetadata(pipeOrDirective);
            if (metadata) {
              compilePipe(outputCtx, metadata, reflector, OutputMode.PartialClass);
            }
          }
        }

      });
}

const DTS = /\.d\.ts$/;
const EXT = /(\.\w+)+$/;
const NONE_WORD = /\W/g;
const NODE_MODULES = /^.*\/node_modules\//;

function getBackPatchFunctionName(type: CompileTypeMetadata) {
  const filePath = (type.reference.filePath as string)
                       .replace(EXT, '')
                       .replace(NODE_MODULES, '')
                       .replace(NONE_WORD, '_');
  return `ngBackPatch_${filePath.split('/').filter(s => !!s).join('_')}_${type.reference.name}`;
}

function getBackPatchReference(type: CompileTypeMetadata): o.Expression {
  return o.variable(getBackPatchFunctionName(type));
}

export function backPatch(
    data: MockDirectory, angularFiles: MockData, options: AotCompilerOptions = {},
    errorCollector: (error: any, fileName?: string) => void = error => { throw error;}) {
  return doCompile(
      data, angularFiles, options, errorCollector,
      (outputCtx: OutputContext, analyzedModules: NgAnalyzedModules,
       resolver: CompileMetadataResolver, htmlParser: HtmlParser, templateParser: TemplateParser,
       hostBindingParser: BindingParser, reflector: StaticReflector) => {

        const parseTemplate =
            (compMeta: CompileDirectiveMetadata, ngModule: CompileNgModuleMetadata,
             directiveIdentifiers: CompileIdentifierMetadata[]) => {
              const directives =
                  directiveIdentifiers.map(dir => resolver.getDirectiveSummary(dir.reference));
              const pipes = ngModule.transitiveModule.pipes.map(
                  pipe => resolver.getPipeSummary(pipe.reference));
              return templateParser.parse(
                  compMeta, compMeta.template !.htmlAst !, directives, pipes, ngModule.schemas,
                  templateSourceUrl(ngModule.type, compMeta, compMeta.template !), true);
            };

        for (const module of analyzedModules.ngModules) {
          compileModuleBackPatch(
              outputCtx, getBackPatchFunctionName(module.type), module,
              DTS.test(module.type.reference.filePath) ? ModuleKind.Renderer2 :
                                                         ModuleKind.Renderer3,
              getBackPatchReference, parseTemplate, reflector, resolver);
        }
      });
}

export function createFactories(
    data: MockDirectory, context: MockData, options: AotCompilerOptions = {},
    errorCollector: (error: any, fileName?: string) => void = error => { throw error;}) {
  return doCompile(
      data, context, options, errorCollector,
      (outputCtx: OutputContext, analyzedModules: NgAnalyzedModules,
       resolver: CompileMetadataResolver, htmlParser: HtmlParser, templateParser: TemplateParser,
       hostBindingParser: BindingParser, reflector: StaticReflector) => {
        for (const module of analyzedModules.ngModules) {
          compileModuleFactory(outputCtx, module, getBackPatchReference, resolver);
        }
      });
}