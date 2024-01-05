import { Inject, Injectable } from '@angular/core';
import { actionMatcher, InitState, UpdateState, getValue, setValue } from '@ngxs/store';
import { AsyncStorageEngine, NGXS_STORAGE_PLUGIN_OPTIONS, NgxsStoragePluginOptions, STORAGE_ENGINE, StorageEngine, AsyncStorageEngineProxy } from './symbols';
import { tap, concatMap, map, reduce } from 'rxjs/operators';
import { NgxsNextPluginFn, NgxsPlugin } from '@ngxs/store/src/symbols';
import { Observable, of, from } from 'rxjs';

const STATE_KEY = '@@STATE';

@Injectable()
export class NgxsAsyncStoragePlugin implements NgxsPlugin {
    private _asyncEngine: AsyncStorageEngine;

    constructor(
        @Inject(NGXS_STORAGE_PLUGIN_OPTIONS) private _options: NgxsStoragePluginOptions,
        @Inject(STORAGE_ENGINE)  private _engine: StorageEngine | AsyncStorageEngine
    ) {
        if (typeof this._engine.length === 'function') {
            this._asyncEngine = <AsyncStorageEngine>this._engine;
        } else {
            this._asyncEngine = new AsyncStorageEngineProxy(<StorageEngine>this._engine);
        }
    }

    handle(state: any, event: any, next: NgxsNextPluginFn) {
        const matches = actionMatcher(event);
        const isInitAction = matches(InitState) || matches(UpdateState);
        const options = this._options || <any>{};
        const keys: string[] = Array.isArray(options.key) ? options.key : [options.key];

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
                    const isMaster = this.isStateKey(key);
                    let nextState = previousState;

                    if (val !== 'undefined' && typeof val !== 'undefined' && val !== null) {
                        try {
                            val = options.deserialize(val);
                        } catch (e) {
                            console.error('Error ocurred while deserializing the store value, falling back to empty object.');
                            val = {};
                        }
                    }

                    if (options.migrations) {
                        options.migrations.forEach((strategy) => {
                            const versionMatch = strategy.version === getValue(val, strategy.versionKey || 'version');
                            const keyMatch = (!strategy.key && isMaster) || strategy.key === key;

                            if (versionMatch && keyMatch) {
                                val = strategy.migrate(val);
                                hasMigration = true;
                            }
                        });
                    }

                    nextState = isMaster ? { ...previousState, ...val } : setValue(previousState, key, val);

                    return nextState;
                }, state)
            );
        }

        return initAction.pipe(
            concatMap(
                (stateAfterInit) => next(stateAfterInit, event)
            ),
            tap((nextState) => {
                if (!isInitAction || (isInitAction && hasMigration)) {
                    for (const key of keys) {
                        let val = nextState;

                        if (!this.isStateKey(key)) {
                            val = getValue(nextState, key);
                        }

                        try {
                            this._asyncEngine.setItem(key, options.serialize(val));
                        } catch (e) {
                            console.error('Error ocurred while serializing the store value, value not updated.');
                        }
                    }
                }
            })
        );
    }

    isStateKey(key: string): boolean {
        return key === STATE_KEY;
    }
}
