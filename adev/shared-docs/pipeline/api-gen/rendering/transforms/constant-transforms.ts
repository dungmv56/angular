/*!
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {ConstantEntry} from '../entities';
import {ConstantEntryRenderable} from '../entities/renderables';
import {addRenderableCodeToc} from './code-transforms';
import {
  addHtmlAdditionalLinks,
  addHtmlDescription,
  addHtmlJsDocTagComments,
  addHtmlUsageNotes,
  setEntryFlags,
} from './jsdoc-transforms';
import {addModuleName} from './module-name';
import {addRepo} from './repo';

/** Given an unprocessed constant entry, get the fully renderable constant entry. */
export function getConstantRenderable(
  classEntry: ConstantEntry,
  moduleName: string,
  repo: string,
): ConstantEntryRenderable {
  return setEntryFlags(
    addRenderableCodeToc(
      addHtmlAdditionalLinks(
        addHtmlUsageNotes(
          addHtmlJsDocTagComments(
            addHtmlDescription(addRepo(addModuleName(classEntry, moduleName), repo)),
          ),
        ),
      ),
    ),
  );
}
