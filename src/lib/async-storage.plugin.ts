import { Inject, Injectable } from '@angular/core';
import {
    NgxsPlugin,
    setValue,
    getValue,
    InitState,
    UpdateState,
    actionMatcher,
} from '@ngxs/store';

import {
    NgxsStoragePluginOptions,
    NGXS_STORAGE_PLUGIN_OPTIONS,
    STORAGE_ENGINE,
    StorageEngine,
    AsyncStorageEngine,
    AsyncStorageEngineProxy,
} from './symbols';
import { tap, concatMap, map, reduce } from 'rxjs/operators';
import { NgxsNextPluginFn } from '@ngxs/store/src/symbols';
import { Observable, of, from } from 'rxjs';

@Injectable()
export class NgxsAsyncStoragePlugin implements NgxsPlugin {
    private _asyncEngine: AsyncStorageEngine;

    constructor(
        @Inject(NGXS_STORAGE_PLUGIN_OPTIONS)
        private _options: NgxsStoragePluginOptions,
        @Inject(STORAGE_ENGINE)
        private _engine: StorageEngine | AsyncStorageEngine
    ) {
        if (typeof this._engine.length === 'function') {
            this._asyncEngine = <AsyncStorageEngine>this._engine;
        } else {
            this._asyncEngine = new AsyncStorageEngineProxy(
                <StorageEngine>this._engine
            );
        }
    }

    handle(state: any, event: any, next: NgxsNextPluginFn) {
        const options = this._options || <any>{};
        const matches = actionMatcher(event);
        const isInitAction = matches(InitState) || matches(UpdateState);
        const keys: string[] = Array.isArray(options.key)
            ? options.key
            : [options.key];
        let hasMigration = false;
        let initAction: Observable<any> = of(state);

        if (isInitAction) {
            initAction = from(keys).pipe(
                concatMap((key) =>
                    this._asyncEngine
                        .getItem(key)
                        .pipe(map((val) => [key, val]))
                ),
                reduce((previousState, [key, val]) => {
                    const isMaster = key === '@@STATE';
                    let nextState = previousState;
                    if (
                        val !== 'undefined' &&
                        typeof val !== 'undefined' &&
                        val !== null
                    ) {
                        try {
                            val = options.deserialize(val);
                        } catch (e) {
                            console.error(
                                'Error ocurred while deserializing the store value, falling back to empty object.'
                            );
                            val = {};
                        }

                        if (options.migrations) {
                            options.migrations.forEach((strategy) => {
                                const versionMatch =
                                    strategy.version ===
                                    getValue(
                                        val,
                                        strategy.versionKey || 'version'
                                    );
                                const keyMatch =
                                    (!strategy.key && isMaster) ||
                                    strategy.key === key;
                                if (versionMatch && keyMatch) {
                                    val = strategy.migrate(val);
                                    hasMigration = true;
                                }
                            });
                        }
                        if (!isMaster) {
                            nextState = setValue(previousState, key, val);
                        } else {
                            nextState = { ...previousState, ...val };
                        }
                    } else {
                        if (options.migrations) {
                            if (isMaster) {
                                val = Object.assign({}, state);
                            } else {
                                val = getValue(state, key);
                            }
                            options.migrations.forEach((strategy) => {
                                const versionMatch =
                                    strategy.version ===
                                    getValue(
                                        val,
                                        strategy.versionKey || 'version'
                                    );
                                const keyMatch =
                                    (!strategy.key && isMaster) ||
                                    strategy.key === key;
                                if (versionMatch && keyMatch) {
                                    val = strategy.migrate(val);
                                    hasMigration = true;
                                }
                            });
                            if (!isMaster) {
                                nextState = setValue(previousState, key, val);
                            } else {
                                nextState = { ...previousState, ...val };
                            }
                        }
                    }
                    return nextState;
                }, state)
            );
        }

        return initAction.pipe(
            concatMap((stateAfterInit) => next(stateAfterInit, event)),
            tap((nextState) => {
                if (!isInitAction || (isInitAction && hasMigration)) {
                    for (const key of keys) {
                        let val = nextState;

                        if (key !== '@@STATE') {
                            val = getValue(nextState, key);
                        }

                        try {
                            this._asyncEngine.setItem(
                                key,
                                options.serialize(val)
                            );
                        } catch (e) {
                            console.error(
                                'Error ocurred while serializing the store value, value not updated.'
                            );
                        }
                    }
                }
            })
        );
    }
}
