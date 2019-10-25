/**
 * @license
 * Copyright 2019 The Neuroglancer Authors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {vec3} from 'gl-matrix';

import {LocalAnnotationSource} from '../annotation';
import {TrackableRGB} from '../util/color';
import {RefCounted, Disposer} from '../util/disposable';
import {verify3dVec, verifyArray, verifyString} from '../util/json';
import {NullarySignal} from '../util/signal';
import {Uint64} from '../util/uint64';

export type ContactSite = {
  coordinate: vec3; area: number;
};

const SEGMENT1_FORMING_CONTACT_SITES_JSON_KEY = 'segment1';
const SEGMENT2_FORMING_CONTACT_SITES_JSON_KEY = 'segment2';
const ANNOTATION_COLOR_JSON_KEY = 'color';
const CONTACT_SITES_PAIRWISE_JSON_KEY = 'contactSites';
const CONTACT_SITES_GROUP_NAME_JSON_KEY = 'name';
const COORDINATE_JSON_KEY = 'coordinate';
const AREA_JSON_KEY = 'area';

abstract class ContactSitesGroup extends RefCounted {
  // protected _name: string;
  changed = this.registerDisposer(new NullarySignal());

  constructor(protected _name: string) {
    super();
  }

  get name() {
    return this._name;
  }

  set name(newName: string) {
    this._name = newName;
    this.changed.dispatch();
  }

  toJSON() {
    return {
      [CONTACT_SITES_GROUP_NAME_JSON_KEY]: this._name
    };
  }
}

export class PairwiseContactSites extends ContactSitesGroup {
  // color = new TrackableRGB(vec3.fromValues(0.0, 0.0, 0.0));
  // private _name: string;
  // segment1: Uint64;
  // segment2: Uint64;
  // contactSites: ContactSite[] = [];

  constructor(
      public segment1: Uint64, public segment2: Uint64, public contactSites: ContactSite[],
      public color: TrackableRGB, name: string) {
    super(name);
    this.registerDisposer(this.color.changed.add(this.changed.dispatch));
  }

  // Factory method
  static fromSpecification(specification: any) {
    const name = verifyString(specification[CONTACT_SITES_GROUP_NAME_JSON_KEY]);
    const segment1 = Uint64.parseString(specification[SEGMENT1_FORMING_CONTACT_SITES_JSON_KEY], 10);
    const segment2 = Uint64.parseString(specification[SEGMENT2_FORMING_CONTACT_SITES_JSON_KEY], 10);
    const color = new TrackableRGB(vec3.fromValues(0.0, 0.0, 0.0));
    color.restoreState(specification[ANNOTATION_COLOR_JSON_KEY]);
    const contactSites: ContactSite[] = [];
    const contactSitesSpec = specification[CONTACT_SITES_PAIRWISE_JSON_KEY];
    verifyArray(contactSitesSpec);
    contactSitesSpec.forEach((contactSiteSpec: any) => {
      const contactSite: ContactSite = {
        coordinate: verify3dVec(contactSiteSpec[COORDINATE_JSON_KEY]),
        area: contactSiteSpec[AREA_JSON_KEY]
      };
      contactSites.push(contactSite);
    });
    return new PairwiseContactSites(segment1, segment2, contactSites, color, name);
  }

  toJSON() {
    const x: any = super.toJSON();
    x[SEGMENT1_FORMING_CONTACT_SITES_JSON_KEY] = this.segment1.toJSON();
    x[SEGMENT2_FORMING_CONTACT_SITES_JSON_KEY] = this.segment2.toJSON();
    x[ANNOTATION_COLOR_JSON_KEY] = this.color.toJSON();
    const contactSitesJSON: any[] = [];
    this.contactSites.forEach(contactSite => {
      contactSitesJSON.push({
        [COORDINATE_JSON_KEY]: [contactSite.coordinate[0], contactSite.coordinate[1], contactSite.coordinate[2]],
        [AREA_JSON_KEY]: contactSite.area
      });
    });
    x[CONTACT_SITES_PAIRWISE_JSON_KEY] = contactSitesJSON;
    return x;
  }
}

const ROOT_JSON_KEY = 'rootId';
const PARTNERS_JSON_KEY = 'partners';
const PARTNER_ROOT_JSON_KEY = 'partnerId';
const AREAS_JSON_KEY = 'areas';

export class AllContactSitesForRoot extends ContactSitesGroup {
  // root: Uint64;
  // Map from each partner root to a list of areas (each contact site is represented by its area
  // here)
  // partners: Map<Uint64, number[]>;

  constructor(public root: Uint64, public partners: Map<Uint64, number[]>, name: string) {
    super(name);
  }

  // restoreState(specification: any) {
  //   this._name = verifyString(specification[CONTACT_SITES_GROUP_NAME_JSON_KEY]);
  //   this.root = Uint64.parseString(specification[ROOT_JSON_KEY], 10);
  //   const partnersSpec = specification[PARTNERS_JSON_KEY];
  //   if (partnersSpec) {
  //     verifyArray(partnersSpec);
  //     partnersSpec.forEach((partnerSpec: any) => {
  //       const partnerId = Uint64.parseString(partnerSpec[PARTNER_ROOT_JSON_KEY], 10);
  //       const contactSiteAreas = partnerSpec[AREAS_JSON_KEY];
  //       verifyArray(contactSiteAreas);
  //       this.partners.set(partnerId, contactSiteAreas);
  //     });
  //   }
  // }

  static fromSpecification(specification: any) {
    const name = verifyString(specification[CONTACT_SITES_GROUP_NAME_JSON_KEY]);
    const root = Uint64.parseString(specification[ROOT_JSON_KEY], 10);
    const partners = new Map<Uint64, number[]>();
    const partnersSpec = specification[PARTNERS_JSON_KEY];
    if (partnersSpec) {
      verifyArray(partnersSpec);
      partnersSpec.forEach((partnerSpec: any) => {
        const partnerId = Uint64.parseString(partnerSpec[PARTNER_ROOT_JSON_KEY], 10);
        const contactSiteAreas = partnerSpec[AREAS_JSON_KEY];
        verifyArray(contactSiteAreas);
        partners.set(partnerId, contactSiteAreas);
      });
    }
    return new AllContactSitesForRoot(root, partners, name);
  }

  toJSON() {
    const x: any = super.toJSON();
    x[ROOT_JSON_KEY] = this.root.toJSON();
    x[CONTACT_SITES_GROUP_NAME_JSON_KEY] = name;
    const partnersListJSON: any[] = [];
    for (const [partner, areas] of this.partners) {
      partnersListJSON.push(
          {[PARTNER_ROOT_JSON_KEY]: partner.toJSON(), [AREAS_JSON_KEY]: areas.toString()});
    }
    x[PARTNERS_JSON_KEY] = partnersListJSON;
    return x;
  }
}

const PAIRWISE_CONTACT_SITES_JSON_KEY = 'pairwiseContactSites';
const ALL_CONTACT_SITES_FOR_ROOT_JSON_KEY = 'contactSitesForRoot';
const SELECTED_SEGMENT1_JSON_KEY = 'selectedSegment1';
const SELECTED_SEGMENT2_JSON_KEY = 'selectedSegment2';
const SELECT_ROOT_SEGMENT_JSON_KEY = 'selectedRoot';

export class ContactSites extends RefCounted {
  pairwiseContactSitesList: PairwiseContactSites[] = [];
  contactSitesForRootList: AllContactSitesForRoot[] = [];
  selectedSegment1?: Uint64;
  selectedSegment2?: Uint64;
  selectedRoot?: Uint64;
  changed = this.registerDisposer(new NullarySignal());
  private disposerMap = new Map<ContactSitesGroup, Disposer>();

  // constructor() {
  //   super();

  // }

  addContactSiteGroup(contactSiteGroup: ContactSitesGroup) {
    if (contactSiteGroup instanceof PairwiseContactSites) {
      this.pairwiseContactSitesList.push(contactSiteGroup);
      this.registerDisposer(contactSiteGroup);
      const signalDisposer = contactSiteGroup.changed.add(this.changed.dispatch);
      this.disposerMap.set(contactSiteGroup, signalDisposer);
      this.registerDisposer(signalDisposer);
    } else if (contactSiteGroup instanceof AllContactSitesForRoot) {
      this.contactSitesForRootList.push(contactSiteGroup);
      this.registerDisposer(contactSiteGroup);
      const signalDisposer = contactSiteGroup.changed.add(this.changed.dispatch);
      this.disposerMap.set(contactSiteGroup, signalDisposer);
      this.registerDisposer(signalDisposer);
    } else {
      // Should never happen
      throw Error('Invalid Contact Site class type');
    }
  }

  deleteContactSiteGroup(contactSiteGroup: ContactSitesGroup) {
    if (contactSiteGroup instanceof PairwiseContactSites) {
      const index = this.pairwiseContactSitesList.indexOf(contactSiteGroup);
      if (index !== -1) {
        this.unregisterDisposer(this.disposerMap.get(contactSiteGroup)!);
        this.disposerMap.delete(contactSiteGroup);
        this.unregisterDisposer(contactSiteGroup);
        this.pairwiseContactSitesList.splice(index, 1);
        contactSiteGroup.dispose();
        return true;
      }
    } else if (contactSiteGroup instanceof AllContactSitesForRoot) {
      const index = this.contactSitesForRootList.indexOf(contactSiteGroup);
      if (index !== -1) {
        this.unregisterDisposer(this.disposerMap.get(contactSiteGroup)!);
        this.disposerMap.delete(contactSiteGroup);
        this.unregisterDisposer(contactSiteGroup);
        this.pairwiseContactSitesList.splice(index, 1);
        contactSiteGroup.dispose();
        return true;
      }
    } else {
      // Should never happen
      throw Error('Invalid Contact Site class type');
    }
    return false;
  }

  restoreState(specification: any) {
    const pairwiseContactSitesSpec = specification[PAIRWISE_CONTACT_SITES_JSON_KEY];
    const pairwiseContactSites = verifyArray(pairwiseContactSitesSpec);
    pairwiseContactSites.forEach(contactSitesGroup => {
      const curContactSitesGroupObject =
          this.registerDisposer(PairwiseContactSites.fromSpecification(contactSitesGroup));
      this.registerDisposer(curContactSitesGroupObject.changed.add(this.changed.dispatch));
      this.pairwiseContactSitesList.push(curContactSitesGroupObject);
    });
    const contactSitesForRootsSpec = specification[ALL_CONTACT_SITES_FOR_ROOT_JSON_KEY];
    const contactSitesForRoots = verifyArray(contactSitesForRootsSpec);
    contactSitesForRoots.forEach(contactSitesGroup => {
      const curContactSitesGroupObject =
          this.registerDisposer(AllContactSitesForRoot.fromSpecification(contactSitesGroup));
      this.registerDisposer(curContactSitesGroupObject.changed.add(this.changed.dispatch));
      this.contactSitesForRootList.push(curContactSitesGroupObject);
    });
    const selectedSegment1 = specification[SELECTED_SEGMENT1_JSON_KEY];
    if (selectedSegment1 !== undefined) {
      this.selectedSegment1 = Uint64.parseString(String(selectedSegment1), 10);
    }
    const selectedSegment2 = specification[SELECTED_SEGMENT2_JSON_KEY];
    if (selectedSegment2 !== undefined) {
      this.selectedSegment2 = Uint64.parseString(String(selectedSegment2), 10);
    }
    const selectedRoot = specification[SELECT_ROOT_SEGMENT_JSON_KEY];
    if (selectedRoot !== undefined) {
      this.selectedRoot = Uint64.parseString(String(selectedRoot), 10);
    }
  }

  toJSON() {
    const x: any = {};
    const pairwiseContactSitesJSON: any[] = [];
    this.pairwiseContactSitesList.forEach(contactSitesGroup => {
      pairwiseContactSitesJSON.push(contactSitesGroup.toJSON());
    });
    x[PAIRWISE_CONTACT_SITES_JSON_KEY] = pairwiseContactSitesJSON;
    const contactSitesForRootsJSON: any[] = [];
    this.contactSitesForRootList.forEach(contactSitesGroup => {
      contactSitesForRootsJSON.push(contactSitesGroup.toJSON());
    });
    x[ALL_CONTACT_SITES_FOR_ROOT_JSON_KEY] = contactSitesForRootsJSON;
    if (this.selectedSegment1) {
      x[SELECTED_SEGMENT1_JSON_KEY] = this.selectedSegment1.toJSON();
    }
    if (this.selectedSegment2) {
      x[SELECTED_SEGMENT2_JSON_KEY] = this.selectedSegment2.toJSON();
    }
    if (this.selectedRoot) {
      x[SELECT_ROOT_SEGMENT_JSON_KEY] = this.selectedRoot.toJSON();
    }
    return x;
  }
}
