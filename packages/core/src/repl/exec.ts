/*
 * Copyright 2017-19 IBM Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The Read-Eval-Print Loop (REPL)
 *
 */

import Debug from 'debug'
const debug = Debug('core/repl')
debug('loading')

import encodeComponent from './encode'
import { split, patterns } from './split'
import { Executor, ReplEval, DirectReplEval } from './types'

import {
  CommandTreeResolution,
  ExecType,
  EvaluatorArgs,
  KResponse,
  ParsedOptions,
  YargsParserFlags
} from '../models/command'

import REPL from '../models/repl'
import isFakeDom from '../util/is-fake-dom'
import {
  RawContent,
  RawResponse,
  isRawResponse,
  isResourceModification,
  isLowLevelLoop,
  MixedResponse,
  MixedResponsePart
} from '../models/entity'
import { ExecOptions, DefaultExecOptions, DefaultExecOptionsForTab } from '../models/execOptions'
import eventBus from '../core/events'
import { CodedError } from '../models/errors'
import { UsageError, UsageModel, UsageRow } from '../core/usage-error'

import { isHeadless, hasLocalAccess } from '../core/capabilities'
import { isHTML } from '../util/types'
import { promiseEach } from '../util/async'
import SymbolTable from '../core/symbol-table'

import { getModel } from '../commands/tree'
import { isSuccessfulCommandResolution } from '../commands/resolution'

import { unlisten } from '../webapp/listen'
import { setStatus, Status } from '../webapp/status'
import { printResults, replResult, streamTo as streamToUI } from '../webapp/print'
import { oops as oopsUI, showHelp } from '../webapp/oops'
import { Tab, getCurrentTab, getTabFromTarget } from '../webapp/tab'
import { getPrompt } from '../webapp/prompt'
import { installBlock, getCurrentBlock, getCurrentProcessingBlock, removeAnyTemps, subblock } from '../webapp/block'

import * as minimist from 'yargs-parser'

let currentEvaluatorImpl: ReplEval = new DirectReplEval()

export const setEvaluatorImpl = (impl: ReplEval): void => {
  debug('setting evaluator impl', impl.name)
  currentEvaluatorImpl = impl
}

/** trim the optional suffix e.g. --last [actionName] */
const stripTrailer = (str: string) => str && str.replace(/\s+.*$/, '')

/** turn --foo into foo and -f into f */
const unflag = (opt: string) => opt && stripTrailer(opt.replace(/^[-]+/, ''))

/**
 * How to handle errors in command execution? Headless might want to
 * override the graphical default
 *
 */
type OopsHandler = (block: HTMLElement, nextBlock: HTMLElement) => (err: Error) => void
let oopsHandler: OopsHandler
export const installOopsHandler = (fn: OopsHandler) => {
  debug('installing oops handler')
  oopsHandler = fn
}
const oops = (command?: string, block?: HTMLElement, nextBlock?: HTMLElement) => (err: Error) => {
  if (oopsHandler) {
    debug('invoking registered oops handler')
    return oopsHandler(block, nextBlock)(err)
  } else {
    return oopsUI(command, block, nextBlock)(err)
  }
}

const emptyExecOptions = (): ExecOptions => new DefaultExecOptions()

function okIf404(err: CodedError) {
  if (err.code === 404) {
    return false
  } else {
    throw err
  }
}
async function lookupCommandEvaluator<T extends KResponse, O extends ParsedOptions>(
  argv: string[],
  execOptions: ExecOptions
): Promise<CommandTreeResolution<T, O>> {
  // first try treating options as binary
  const tryCatchalls = false
  const argvNoOptions = argv.filter((_, idx, A) => _.charAt(0) !== '-' && (idx === 0 || A[idx - 1].charAt(0) !== '-'))
  const evaluator = await getModel()
    .read<T, O>(argvNoOptions, execOptions, tryCatchalls)
    .catch(okIf404)

  if (!isSuccessfulCommandResolution(evaluator)) {
    // then try treating options as unary
    const tryCatchalls2 = false
    const argvNoOptions2 = argv.filter(_ => _.charAt(0) !== '-')
    const evaluator2 = await getModel()
      .read<T, O>(argvNoOptions2, execOptions, tryCatchalls2)
      .catch(okIf404)
    if (isSuccessfulCommandResolution(evaluator2)) {
      return evaluator2
    } else {
      const tryCatchalls3 = true
      const evaluator3 = await getModel().read<T, O>(argvNoOptions, execOptions, tryCatchalls3)
      if (isSuccessfulCommandResolution(evaluator3)) {
        return evaluator3
      }
    }
  }

  return evaluator
}

/**
 * Execute the given command-line directly in this process
 *
 */
class InProcessExecutor implements Executor {
  public name = 'InProcessExecutor'

  public async exec<T extends KResponse, O extends ParsedOptions>(
    commandUntrimmed: string,
    execOptions = emptyExecOptions()
  ): Promise<T | CodedError<number> | HTMLElement> {
    const tab = execOptions.tab || getCurrentTab()
    const REPL = getImpl(tab) // eslint-disable-line @typescript-eslint/no-use-before-define

    if (!isHeadless()) {
      const curDic = SymbolTable.read(tab)
      if (typeof curDic !== 'undefined') {
        if (!execOptions.env) {
          execOptions.env = {}
        }
        execOptions.env = Object.assign({}, execOptions.env, curDic)
      }
    }

    const echo = !execOptions || execOptions.echo !== false
    const nested = execOptions && execOptions.noHistory && !execOptions.replSilence
    if (nested) execOptions.nested = nested

    const block = (execOptions && execOptions.block) || getCurrentBlock(tab)
    const blockParent = block && block.parentNode // remember this one, in case the command removes block from its parent
    const prompt = block && getPrompt(block)

    // maybe execOptions has been attached to the prompt dom (e.g. see repl.partial)
    if (!execOptions) execOptions = prompt.execOptions
    if (execOptions && execOptions.pip) {
      const { container, returnTo } = execOptions.pip
      try {
        const { drilldown } = await import('../webapp/picture-in-picture') // FIXME
        await drilldown(tab, commandUntrimmed, undefined, document.querySelector(container), returnTo)()
        return
      } catch (err) {
        console.error(err as Error)
        // fall through to normal execution, if pip fails
      }
    }

    // clone the current block so that we have one for the next
    // prompt, when we're done evaluating the current command
    let nextBlock: HTMLElement
    if (!execOptions || (!execOptions.noHistory && echo)) {
      // this is a top-level exec
      unlisten(prompt)
      nextBlock = (execOptions && execOptions.nextBlock) || (block.cloneNode(true) as HTMLElement)

      // since we cloned it, make sure it's all cleaned out
      nextBlock.querySelector('input').value = ''
      // nextBlock.querySelector('input').setAttribute('placeholder', 'enter your command')
    } else {
      // qfexec with nextBlock, see rm plugin
      nextBlock = execOptions && execOptions.nextBlock
    }

    if (nextBlock) {
      // remove any .repl-temporary that might've come along for the
      // ride when we cloned the current block
      removeAnyTemps(nextBlock)
    }

    // blank line, after removing comments?
    const command = commandUntrimmed.trim().replace(patterns.commentLine, '')
    if (!command) {
      if (block) {
        setStatus(block, Status.validResponse)
        installBlock(blockParent, block, nextBlock)()
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (true as any) as T
    }

    if (execOptions && execOptions.echo && prompt) {
      // this is a programmatic exec, so make the command appear in the console
      prompt.value = commandUntrimmed
    }

    try {
      if (block && !nested && echo) {
        setStatus(block, Status.processing)
        prompt.readOnly = true
      }

      const argv = split(command)
      // debug('split', command, argv)

      if (argv.length === 0) {
        if (block) {
          setStatus(block, Status.validResponse)
          installBlock(blockParent, block, nextBlock)()
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (true as any) as T
      }

      // add a history entry
      if (!execOptions || !execOptions.noHistory) {
        if (!execOptions || !execOptions.quiet) {
          const historyModel = (await import('../models/history')).default
          execOptions.history = historyModel.add({
            raw: command
          })
        }
      }

      // the Read part of REPL
      const evaluator = await lookupCommandEvaluator<T, O>(argv, execOptions)
      if (isSuccessfulCommandResolution(evaluator)) {
        //
        // fetch the usage model for the command
        //
        const _usage: UsageModel = evaluator.options && evaluator.options.usage
        const usage: UsageModel = _usage && _usage.fn ? _usage.fn(_usage.command) : _usage
        // debug('usage', usage)

        if (execOptions && execOptions.failWithUsage && !usage) {
          debug('caller needs usage model, but none exists for this command', evaluator)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (false as any) as T
        }

        const builtInOptions: UsageRow[] = [{ name: '--quiet', alias: '-q', hidden: true, boolean: true }]
        if (!usage || !usage.noHelp) {
          // usage might tell us not to add help, or not to add the -h help alias
          const help: { name: string; hidden: boolean; boolean: boolean; alias?: string } = {
            name: '--help',
            hidden: true,
            boolean: true
          }
          if (!usage || !usage.noHelpAlias) {
            help.alias = '-h'
          }
          builtInOptions.push(help)
        }

        // here, we encode some common aliases, and then overlay any flags from the command
        // narg: any flags that take more than one argument e.g. -p key value would have { narg: { p: 2 } }
        const commandFlags: YargsParserFlags =
          (evaluator.options && evaluator.options.flags) ||
          (evaluator.options &&
            evaluator.options.synonymFor &&
            evaluator.options.synonymFor.options &&
            evaluator.options.synonymFor.options.flags) ||
          ({} as YargsParserFlags)
        const optional = builtInOptions.concat(
          (evaluator.options && evaluator.options.usage && evaluator.options.usage.optional) || []
        )
        const optionalBooleans = optional && optional.filter(({ boolean }) => boolean).map(_ => unflag(_.name))

        interface CanonicalArgs {
          [key: string]: string
        }
        const optionalAliases =
          optional &&
          optional
            .filter(({ alias }) => alias)
            .reduce((M: CanonicalArgs, { name, alias }) => {
              M[unflag(alias)] = unflag(name)
              return M
            }, {})

        interface ArgCount {
          [key: string]: number
        }
        const allFlags = {
          configuration: Object.assign(
            { 'camel-case-expansion': false },
            (evaluator.options && evaluator.options.flags && evaluator.options.flags.configuration) ||
              (usage && usage.configuration) ||
              {}
          ),
          boolean: (commandFlags.boolean || []).concat(optionalBooleans || []),
          alias: Object.assign({}, commandFlags.alias || {}, optionalAliases || {}),
          narg: Object.assign(
            {},
            commandFlags.narg || {}, // narg from registrar.listen(route, handler, { flags: { narg: ... }})
            (optional &&
              optional.reduce((N, { name, alias, narg }) => {
                // narg from listen(route, handler, { usage: { optional: [...] }})
                if (narg) {
                  N[unflag(name)] = narg
                  N[unflag(alias)] = narg
                }
                return N
              }, {} as Record<string, number>)) ||
              {}
          )
        }

        // now use minimist to parse the command line options
        // minimist stores the residual, non-opt, args in _
        const parsedOptions: ParsedOptions = minimist(argv, allFlags)
        const argvNoOptions: string[] = parsedOptions._

        //
        // if the user asked for help, and the plugin registered a
        // usage model, we can service that here, without having
        // to involve the plugin. this lets us avoid having each
        // plugin check for options.help
        //
        if ((!usage || !usage.noHelp) && parsedOptions.help && evaluator.options && evaluator.options.usage) {
          if (execOptions && execOptions.failWithUsage) {
            return evaluator.options.usage as T
          } else {
            oops(command, block, nextBlock)(new UsageError({ usage: evaluator.options.usage }))
            return
          }
        }

        //
        // here is where we enforce the usage model
        //
        if (usage && usage.strict) {
          // strict: command wants *us* to enforce conformance
          // required and optional parameters
          const { strict: cmd, onlyEnforceOptions = false, required = [], oneof = [], optional: _optional = [] } = usage
          const optLikeOneOfs: UsageRow[] = oneof.filter(({ command, name = command }) => name.charAt(0) === '-') // some one-ofs might be of the form --foo
          const positionalConsumers = _optional.filter(
            ({ name, alias, consumesPositional }) =>
              consumesPositional && (parsedOptions[unflag(name)] || parsedOptions[unflag(alias)])
          )
          const optional = builtInOptions.concat(_optional).concat(optLikeOneOfs)
          const positionalOptionals = optional.filter(({ positional }) => positional)
          const nPositionalOptionals = positionalOptionals.length

          // just introducing a shorter variable name, here
          const args = argvNoOptions
          const nPositionalsConsumed = positionalConsumers.length
          const nRequiredArgs = required.length + (oneof.length > 0 ? 1 : 0) - nPositionalsConsumed
          const optLikeActuals = optLikeOneOfs.filter(
            ({ name, alias = '' }) =>
              Object.prototype.hasOwnProperty.call(parsedOptions, unflag(name)) ||
              Object.prototype.hasOwnProperty.call(parsedOptions, unflag(alias))
          )
          const nOptLikeActuals = optLikeActuals.length
          const cmdArgsStart = args.indexOf(cmd)
          const nActualArgs = args.length - cmdArgsStart - 1 + nOptLikeActuals

          // did the user pass an unsupported optional parameter?
          for (const optionalArg in parsedOptions) {
            // skip over minimist's _
            if (optionalArg === '_' || parsedOptions[optionalArg] === false) {
              // minimist nonsense
              continue
            }

            // should we enforce this option?
            const enforceThisOption =
              onlyEnforceOptions === undefined || typeof onlyEnforceOptions === 'boolean'
                ? true
                : !!onlyEnforceOptions.find(_ => _ === `-${optionalArg}` || _ === `--${optionalArg}`)

            if (!enforceThisOption) {
              // then neither did the spec didn't mention anything about enforcement (!onlyEnforceOptions)
              // nor did the spec said only to enforce options, but enforce them all (onlyEnforceOptions === true)
              // nor did the spec enumerated options to enforce, and this is one of them
              continue
            }

            // find a matching declared optional arg
            const match = optional.find(({ name, alias }) => {
              return (
                stripTrailer(alias) === `-${optionalArg}` ||
                stripTrailer(name) === `-${optionalArg}` ||
                stripTrailer(name) === `--${optionalArg}`
              )
            })

            if (!match) {
              //
              // then the user passed an option, but the command doesn't accept it
              //
              debug('unsupported optional paramter', optionalArg)

              const message = `Unsupported optional parameter ${optionalArg}`
              const err = new UsageError({ message, usage })
              err.code = 499
              debug(message, args, parsedOptions, optional, argv) // args is argv with options stripped
              if (execOptions && execOptions.failWithUsage) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return (err as any) as T
              } else {
                oops(command, block, nextBlock)(err)
                return
              }
            } else if (
              (match.boolean && typeof parsedOptions[optionalArg] !== 'boolean') ||
              (match.file && typeof parsedOptions[optionalArg] !== 'string') ||
              (match.booleanOK &&
                !(typeof parsedOptions[optionalArg] === 'boolean' || typeof parsedOptions[optionalArg] === 'string')) ||
              (match.numeric && typeof parsedOptions[optionalArg] !== 'number') ||
              (match.narg > 1 && !Array.isArray(parsedOptions[optionalArg])) ||
              (!match.boolean &&
                !match.booleanOK &&
                !match.numeric &&
                (!match.narg || match.narg === 1) &&
                !(
                  typeof parsedOptions[optionalArg] === 'string' ||
                  typeof parsedOptions[optionalArg] === 'number' ||
                  typeof parsedOptions[optionalArg] === 'boolean'
                )) ||
              // is the given option not one of the allowed options
              (match.allowed &&
                !match.allowed.find(
                  _ =>
                    _ === parsedOptions[optionalArg] ||
                    _ === '...' ||
                    (match.allowedIsPrefixMatch && parsedOptions[optionalArg].toString().indexOf(_.toString()) === 0)
                ))
            ) {
              //
              // then the user passed an option, but of the wrong type
              //
              debug('bad value for option', optionalArg, match, parsedOptions, args, allFlags)

              const expectedMessage = match.boolean
                ? ', expected boolean'
                : match.numeric
                ? ', expected a number'
                : match.file
                ? ', expected a file path'
                : ''

              const message = `Bad value for option ${optionalArg}${expectedMessage}${
                typeof parsedOptions[optionalArg] === 'boolean' ? '' : ', got ' + parsedOptions[optionalArg]
              }${match.allowed ? ' expected one of: ' + match.allowed.join(', ') : ''}`
              const error = new UsageError({ message, usage })
              debug(message, match)
              error.code = 498
              if (execOptions && execOptions.failWithUsage) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return (error as any) as T
              } else {
                oops(command, block, nextBlock)(error)
                return
              }
            }
          }

          //
          // user passed an incorrect number of positional parameters?
          //
          if (!onlyEnforceOptions && nActualArgs !== nRequiredArgs) {
            // it's ok if we have nActualArgs in the range [nRequiredArgs, nRequiredArgs + nPositionalOptionals]
            if (!(nActualArgs >= nRequiredArgs && nActualArgs <= nRequiredArgs + nPositionalOptionals)) {
              // yup, scan for implicitOK
              const implicitIdx = required.findIndex(({ implicitOK }) => implicitOK !== undefined)
              const { currentSelection } = await import('../webapp/views/sidecar-visibility') // FIXME
              const selection = currentSelection(tab)

              let nActualArgsWithImplicit = nActualArgs

              if (implicitIdx >= 0 && selection && required[implicitIdx].implicitOK.find(_ => _ === selection.kind)) {
                nActualArgsWithImplicit++

                // if implicit, maybe other required parameters aren't needed
                const notNeededIfImplicit = required.filter(({ notNeededIfImplicit }) => notNeededIfImplicit)
                nActualArgsWithImplicit += notNeededIfImplicit.length
              }

              if (nActualArgsWithImplicit !== nRequiredArgs) {
                // then either the command didn't specify
                // implicitOK, or the current selection
                // (or lack thereof) didn't match with the
                // command's typing requirement
                const message =
                  nRequiredArgs === 0 && nPositionalOptionals === 0
                    ? 'This command accepts no positional arguments'
                    : nPositionalOptionals > 0
                    ? 'This command does not accept this number of arguments'
                    : `This command requires ${nRequiredArgs} parameter${
                        nRequiredArgs === 1 ? '' : 's'
                      }, but you provided ${nActualArgsWithImplicit === 0 ? 'none' : nActualArgsWithImplicit}`
                const err = new UsageError({ message, usage })
                err.code = 497
                debug(message, cmd, nActualArgs, nRequiredArgs, args, optLikeActuals)

                if (execOptions && execOptions.nested) {
                  debug('returning usage error')
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  return (err as any) as T
                } else {
                  debug('broadcasting usage error')
                  oops(command, block, nextBlock)(err)
                  return
                }
              } else {
                debug('repl selection', selection)
                // splice in the implicit parameter
                args.splice(
                  implicitIdx,
                  cmdArgsStart + 1,
                  selection.metadata.namespace
                    ? `/${selection.metadata.namespace}/${selection.metadata.name}`
                    : selection.metadata.name
                )
                debug('spliced in implicit argument', cmdArgsStart, implicitIdx, args)
              }
            }
          }
        } /* strict usage model conformance checking */

        /* if (evaluator.options && !(await hasAuth()) && !evaluator.options.noAuthOk) {
          debug('command requires auth, and we do not have it')
          const err = new Error('Command requires authentication') as CodedError
          err.code = 403
          return oops(command, block, nextBlock)(err)
        } */

        if (evaluator.options && evaluator.options.requiresLocal && !hasLocalAccess()) {
          debug('command does not work in a browser')
          const err = new Error('Command requires local access') as CodedError
          err.code = 406 // http not acceptable
          oops(command, block, nextBlock)(err)
          return
        }

        // if we don't have a head (yet), but this command
        // requires one, then ask for a head and try again. note
        // that we ignore this needsUI constraint if the user is
        // asking for help
        if (
          isHeadless() &&
          !parsedOptions.cli &&
          !parsedOptions.help &&
          ((process.env.DEFAULT_TO_UI && !parsedOptions.cli) || (evaluator.options && evaluator.options.needsUI))
        ) {
          import('../main/headless').then(({ createWindow }) =>
            createWindow(argv, evaluator.options.fullscreen, evaluator.options)
          )
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (true as any) as T
        }

        if (execOptions && execOptions.placeholder && prompt) {
          // prompt might not be defined, e.g. if the command
          // does a qexec, i.e. delegates to some other command;
          // that's ok, because in that case, we've already
          // displayed the placeholder
          prompt.value = execOptions.placeholder
        }

        //
        // the Eval part of REPL
        //
        const response = Promise.resolve()
          .then(() => {
            eventBus.emit('/command/start', {
              tab,
              route: evaluator.route,
              command,
              execType: (execOptions && execOptions.type) || ExecType.TopLevel
            })

            return currentEvaluatorImpl.apply<T, O>(commandUntrimmed, execOptions, evaluator, {
              tab,
              // eslint-disable-next-line @typescript-eslint/no-use-before-define
              REPL,
              block: block || true,
              nextBlock,
              argv,
              command,
              execOptions,
              argvNoOptions,
              parsedOptions: parsedOptions as O,
              createOutputStream:
                execOptions.createOutputStream ||
                (async () => {
                  if (isHeadless()) {
                    const { streamTo: headlessStreamTo } = await import('../main/headless-support')
                    return headlessStreamTo()
                  } else {
                    return Promise.resolve(streamToUI(tab, block))
                  }
                })
            })
          })
          .then(async (response: T) => {
            if (execOptions.rawResponse) {
              return response
            }

            if (response === undefined) {
              // weird, the response is empty!
              console.error(argv)
              throw new Error('Internal Error')
            }

            if (block && block.isCancelled) {
              // user cancelled the command
              debug('squashing output of cancelled command')
              return
            }

            if (isResourceModification(response) && response.verb === 'delete') {
              const { maybeHideEntity } = await import('../webapp/views/sidecar') // FIXME
              if (maybeHideEntity(tab, response) && nextBlock) {
                // cli.setContextUI(commandTree.currentContext(), nextBlock)
              }
            }

            if (UsageError.isUsageError(response)) {
              throw response
            }

            // indicate that the command was successfuly completed
            evaluator.success({
              tab,
              type: (execOptions && execOptions.type) || ExecType.TopLevel,
              isDrilldown: execOptions.isDrilldown,
              command,
              parsedOptions
            })

            const render = execOptions && !!execOptions.render

            // response=true means we are in charge of 'ok'
            if (
              !render &&
              ((execOptions && execOptions.replSilence) || nested || isLowLevelLoop(response) || isFakeDom(block))
            ) {
              // the parent exec will deal with the repl
              // debug('passing control back to prompt processor or headless')
              return Promise.resolve(response)
            } else {
              // we're the top-most exec, so deal with the repl!
              const resultDom = render ? replResult() : (block.querySelector('.repl-result') as HTMLElement)
              const rresponse = new Promise<T | CodedError<number> | HTMLElement>(resolve => {
                printResults(
                  block,
                  nextBlock,
                  tab,
                  resultDom,
                  echo && !render,
                  execOptions,
                  command,
                  evaluator
                )(response) // <--- the Print part of REPL
                  .then(() => {
                    if (render) {
                      resolve(resultDom.parentElement)
                    } else if (echo) {
                      // <-- create a new input, for the next iter of the Loop
                      setTimeout(() => {
                        installBlock(blockParent, block, nextBlock)()
                        resolve(response)
                      }, 100)
                    } else {
                      // even if we aren't installing a new block,
                      // make sure that the input is focused (but
                      // don't scroll to make it visible)
                      getPrompt(block).focus({ preventScroll: true })
                      resolve(response)
                    }
                  })
                  .catch((err: Error) => {
                    console.error(err)
                    if (execOptions && execOptions.noHistory) {
                      // then pass the error upstream
                      throw err
                    } else {
                      // then report the error to the repl
                      oops(command, block, nextBlock)(err)
                    }
                  })
              })
              return rresponse
            }
          })
          .catch((err: CodedError) => {
            // how should we handle the error?
            const returnIt = execOptions && execOptions.failWithUsage // return to caller; it'll take care of things from now
            const rethrowIt = execOptions && execOptions.rethrowErrors // rethrow the exception
            const reportIt = execOptions && execOptions.reportErrors // report it to the user via the repl

            if (returnIt) {
              debug('returning command execution error', err.code, err)
              return err
            } else if (isHeadless()) {
              debug('rethrowing error because we are in headless mode', err)
              throw err
            } else {
              // indicate that the command was NOT successfuly completed
              err = evaluator.error(command, tab, (execOptions && execOptions.type) || ExecType.TopLevel, err)

              if (!nested && !rethrowIt) {
                debug('reporting command execution error to user via repl', err)
                // console.error(err)
                oops(command, block, nextBlock)(err)
              } else {
                debug('rethrowing command execution error', err)
                if (reportIt) {
                  // maybe the caller also wants us to report it via the repl?
                  debug('also reporting command execution error to user via repl', err)
                  oops(command, block, nextBlock)(err)
                }
                throw err
              }
            }
          })
        return response
      }
    } catch (err) {
      const e = err as CodedError

      if (e.code !== 404) {
        console.error(err)
      }

      if (execOptions && execOptions.failWithUsage) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (e as any) as T
      } else if (isHeadless()) {
        throw e
      }

      console.error('catastrophic error in repl')
      console.error(e)

      if (execOptions.nested) {
        // for nested/qexecs, we don't want to report anything to the
        // repl
        return
      }

      const blockForError = block || getCurrentProcessingBlock(tab)

      await Promise.resolve(e.message).then(message => {
        if (isHTML(message)) {
          e.message = message
          oops(command, block, nextBlock)(e)
        } else {
          const cmd = showHelp(command, blockForError, nextBlock, e)
          const resultDom = blockForError.querySelector('.repl-result') as HTMLElement
          return Promise.resolve(cmd)
            .then(printResults(blockForError, nextBlock, tab, resultDom))
            .then(() => installBlock(blockForError.parentNode, blockForError, nextBlock)())
        }
      })
    }
  }
} /* InProcessExecutor */

/**
 * Execute the given command-line. This function operates by
 * delegation to the IExecutor impl.
 *
 */
let currentExecutorImpl: Executor = new InProcessExecutor()
export const exec = (commandUntrimmed: string, execOptions = emptyExecOptions()) => {
  return currentExecutorImpl.exec(commandUntrimmed, execOptions)
}

/**
 * User hit enter in the REPL
 *
 */
export const doEval = ({ block = getCurrentBlock(), prompt = getPrompt(block) } = {}) => {
  const command = prompt.value.trim()

  if (block.completion) {
    // then this is a follow-up to prompt
    block.completion(prompt.value)
  } else {
    // otherwise, this is a plain old eval, resulting from the user hitting Enter
    return exec(command, new DefaultExecOptionsForTab(getTabFromTarget(prompt)))
  }
}

/**
 * If, while evaluating a command, it needs to evaluate a sub-command...
 *
 */
export const qexec = <T extends KResponse>(
  command: string,
  block?: HTMLElement | boolean,
  contextChangeOK?: boolean,
  execOptions?: ExecOptions,
  nextBlock?: HTMLElement
): Promise<T> => {
  return exec(
    command,
    Object.assign(
      {
        block: block,
        nextBlock: nextBlock,
        noHistory: true,
        contextChangeOK
      },
      execOptions,
      {
        type: ExecType.Nested
      }
    )
  ) as Promise<T>
}
export const qfexec = (
  command: string,
  block?: HTMLElement,
  nextBlock?: HTMLElement,
  execOptions?: ExecOptions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> => {
  // context change ok, final exec in a chain of nested execs
  return qexec(command, block, true, execOptions, nextBlock)
}

/**
 * "raw" exec, where we want the data model back directly
 *
 */
export const rexec = async <Raw extends RawContent>(
  command: string,
  execOptions = emptyExecOptions()
): Promise<RawResponse<Raw>> => {
  const content = await qexec<Raw | RawResponse<Raw>>(
    command,
    undefined,
    undefined,
    Object.assign({ raw: true }, execOptions)
  )

  if (isRawResponse(content)) {
    return content
  } else {
    // bad actors may return a string; adapt this to RawResponse
    return {
      mode: 'raw',
      content
    }
  }
}

/**
 * Programmatic exec, as opposed to human typing and hitting enter
 *
 */
export const pexec = <T extends KResponse>(command: string, execOptions?: ExecOptions): Promise<T> => {
  return exec(command, Object.assign({ echo: true, type: ExecType.ClickHandler }, execOptions)) as Promise<T>
}

/**
 * Execute a command in response to an in-view click
 *
 */
export const click = async (command: string | (() => Promise<string>), evt: MouseEvent): Promise<void> => {
  const { drilldown } = await import('../webapp/picture-in-picture')
  const tab = getTabFromTarget(evt.currentTarget)
  await drilldown(tab, command)(evt)
}

/**
 * Update the executor impl
 *
 */
export const setExecutorImpl = (impl: Executor): void => {
  currentExecutorImpl = impl
}

/**
 * If the command is semicolon-separated, invoke each element of the
 * split separately
 *
 */
export async function semicolonInvoke(opts: EvaluatorArgs): Promise<MixedResponse> {
  const commands = opts.command.split(/\s*;\s*/)
  if (commands.length > 1) {
    debug('semicolonInvoke', commands)

    const result: MixedResponse = await promiseEach(
      commands.filter(_ => _),
      async command => {
        const block = subblock()

        // note: xterm.js 3.14 requires that this subblock be attached
        // somewhere; it'll be reattached in the right place by
        // cli.printResults, when the commands are all done
        if (typeof opts.block !== 'boolean') {
          opts.block.querySelector('.repl-result').appendChild(block)
        }

        const entity = await qexec<MixedResponsePart | true>(
          command,
          block,
          undefined,
          Object.assign({}, opts.execOptions, { quiet: false })
        )
        if (entity === true) {
          // pty output
          return block
        } else {
          // not a pty, so remove that subblock, as we have an entity response
          block.remove()
          return entity
        }
      }
    )
    return result
  }
}

/**
 * @return an instance that obeys the REPL interface
 *
 */
export function getImpl(tab: Tab): REPL {
  const impl = { qexec, rexec, pexec, click, semicolonInvoke, encodeComponent, split } as REPL
  tab.REPL = impl
  return impl
}
