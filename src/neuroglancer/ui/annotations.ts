/**
 * @license
 * Copyright 2018 Google Inc.
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

/**
 * @file User interface for display and editing annotations.
 */

import './annotations.css';

import debounce from 'lodash/debounce';
import {Annotation, AnnotationReference, AnnotationSource, AnnotationTag, AnnotationType, AxisAlignedBoundingBox, Collection, Ellipsoid, getAnnotationTypeHandler, Line, LineStrip, LocalAnnotationSource} from 'neuroglancer/annotation';
import {AnnotationLayer, AnnotationLayerState, PerspectiveViewAnnotationLayer, SliceViewAnnotationLayer} from 'neuroglancer/annotation/frontend';
import {DataFetchSliceViewRenderLayer, MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend_source';
import {setAnnotationHoverStateFromMouseState} from 'neuroglancer/annotation/selection';
import {MouseSelectionState, UserLayer} from 'neuroglancer/layer';
import {VoxelSize} from 'neuroglancer/navigation_state';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {TrackableAlphaValue, trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {registerNested, TrackableValueInterface, WatchableRefCounted, WatchableValue} from 'neuroglancer/trackable_value';
import {registerTool, Tool} from 'neuroglancer/ui/tool';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren, removeFromParent} from 'neuroglancer/util/dom';
import {mat3, mat3FromMat4, mat4, transformVectorByMat4, vec3} from 'neuroglancer/util/geom';
import {verifyObject, verifyObjectProperty, verifyOptionalInt, verifyOptionalString, verifyString} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {formatBoundingBoxVolume, formatIntegerBounds, formatIntegerPoint, formatLength} from 'neuroglancer/util/spatial_units';
import {Uint64} from 'neuroglancer/util/uint64';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {makeCloseButton} from 'neuroglancer/widget/close_button';
import {ColorWidget} from 'neuroglancer/widget/color';
import {MinimizableGroupWidget} from 'neuroglancer/widget/minimizable_group';
import {RangeWidget} from 'neuroglancer/widget/range';
import {StackView, Tab} from 'neuroglancer/widget/tab_view';
import {makeTextIconButton} from 'neuroglancer/widget/text_icon_button';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';

const Papa = require('papaparse');

type AnnotationIdAndPart = {
  id: string,
  partIndex?: number
};

export class AnnotationSegmentListWidget extends RefCounted {
  element = document.createElement('div');
  private addSegmentWidget = this.registerDisposer(new Uint64EntryWidget());
  private segmentationState: SegmentationDisplayState|undefined|null;
  private debouncedUpdateView = debounce(() => this.updateView(), 0);
  constructor(
      public reference: Borrowed<AnnotationReference>,
      public annotationLayer: AnnotationLayerState) {
    super();
    this.element.className = 'neuroglancer-annotation-segment-list';
    const {addSegmentWidget} = this;
    addSegmentWidget.element.style.display = 'inline-block';
    addSegmentWidget.element.title = 'Associate segments';
    this.element.appendChild(addSegmentWidget.element);
    this.registerDisposer(annotationLayer.segmentationState.changed.add(this.debouncedUpdateView));
    this.registerDisposer(() => this.unregisterSegmentationState());
    this.registerDisposer(this.addSegmentWidget.valuesEntered.add(values => {
      const annotation = this.reference.value;
      if (annotation == null) {
        return;
      }
      const existingSegments = annotation.segments;
      const segments = [...(existingSegments || []), ...values];
      const newAnnotation = {...annotation, segments};
      this.annotationLayer.source.update(this.reference, newAnnotation);
      this.annotationLayer.source.commit(this.reference);
    }));
    this.registerDisposer(reference.changed.add(this.debouncedUpdateView));
    this.updateView();
  }

  private unregisterSegmentationState() {
    const {segmentationState} = this;
    if (segmentationState != null) {
      segmentationState.rootSegments.changed.remove(this.debouncedUpdateView);
      segmentationState.segmentColorHash.changed.remove(this.debouncedUpdateView);
      segmentationState.segmentSelectionState.changed.remove(this.debouncedUpdateView);
      this.segmentationState = undefined;
    }
  }

  private updateView() {
    const segmentationState = this.annotationLayer.segmentationState.value;
    if (segmentationState !== this.segmentationState) {
      this.unregisterSegmentationState();
      this.segmentationState = segmentationState;
      if (segmentationState != null) {
        segmentationState.rootSegments.changed.add(this.debouncedUpdateView);
        segmentationState.segmentColorHash.changed.add(this.debouncedUpdateView);
        segmentationState.segmentSelectionState.changed.add(this.debouncedUpdateView);
      }
    }

    const {element} = this;
    // Remove existing segment representations.
    for (let child = this.addSegmentWidget.element.nextElementSibling; child !== null;) {
      const next = child.nextElementSibling;
      element.removeChild(child);
      child = next;
    }
    element.style.display = 'none';
    const annotation = this.reference.value;
    if (annotation == null) {
      return;
    }
    const segments = annotation.segments;
    if (segmentationState === null) {
      return;
    }
    element.style.display = '';
    if (segments === undefined || segments.length === 0) {
      return;
    }
    const segmentColorHash = segmentationState ? segmentationState.segmentColorHash : undefined;
    segments.forEach((segment, index) => {
      if (index !== 0) {
        element.appendChild(document.createTextNode(' '));
      }
      const child = document.createElement('span');
      child.title =
          'Double click to toggle segment visibility, control+click to disassociate segment from annotation.';
      child.className = 'neuroglancer-annotation-segment-item';
      child.textContent = segment.toString();
      if (segmentationState !== undefined) {
        child.style.backgroundColor = segmentColorHash!.computeCssColor(segment);
        child.addEventListener('mouseenter', () => {
          segmentationState.segmentSelectionState.set(segment);
        });
        child.addEventListener('mouseleave', () => {
          segmentationState.segmentSelectionState.set(null);
        });
        child.addEventListener('dblclick', (event: MouseEvent) => {
          if (event.ctrlKey) {
            return;
          }
          if (segmentationState.rootSegments.has(segment)) {
            segmentationState.rootSegments.delete(segment);
          } else {
            segmentationState.rootSegments.add(segment);
          }
        });
      }
      child.addEventListener('click', (event: MouseEvent) => {
        if (!event.ctrlKey) {
          return;
        }
        const existingSegments = annotation.segments || [];
        const newSegments = existingSegments.filter(x => !Uint64.equal(segment, x));
        const newAnnotation = {...annotation, segments: newSegments ? newSegments : undefined};
        this.annotationLayer.source.update(this.reference, newAnnotation);
        this.annotationLayer.source.commit(this.reference);
      });
      element.appendChild(child);
    });
  }
}

export class SelectedAnnotationState extends RefCounted implements
    TrackableValueInterface<AnnotationIdAndPart|undefined> {
  private value_: AnnotationIdAndPart|undefined;
  changed = new NullarySignal();

  private annotationLayer: AnnotationLayerState|undefined;
  private reference_: Owned<AnnotationReference>|undefined;

  get reference() {
    return this.reference_;
  }

  constructor(public annotationLayerState: Owned<WatchableRefCounted<AnnotationLayerState>>) {
    super();
    this.registerDisposer(annotationLayerState);
    this.registerDisposer(annotationLayerState.changed.add(this.validate));
    this.updateAnnotationLayer();
    this.reference_ = undefined;
    this.value_ = undefined;
  }

  get value() {
    return this.value_;
  }

  get validValue() {
    return this.annotationLayer && this.value_;
  }

  set value(value: AnnotationIdAndPart|undefined) {
    this.value_ = value;
    const reference = this.reference_;
    if (reference !== undefined) {
      if (value === undefined || reference.id !== value.id) {
        this.unbindReference();
      }
    }
    this.validate();
    this.changed.dispatch();
  }

  private updateAnnotationLayer() {
    const annotationLayer = this.annotationLayerState.value;
    if (annotationLayer === this.annotationLayer) {
      return false;
    }
    this.unbindLayer();
    this.annotationLayer = annotationLayer;
    if (annotationLayer !== undefined) {
      annotationLayer.source.changed.add(this.validate);
    }
    return true;
  }

  private unbindLayer() {
    if (this.annotationLayer !== undefined) {
      this.annotationLayer.source.changed.remove(this.validate);
      this.annotationLayer = undefined;
    }
  }

  disposed() {
    this.unbindLayer();
    this.unbindReference();
    super.disposed();
  }

  private unbindReference() {
    const reference = this.reference_;
    if (reference !== undefined) {
      reference.changed.remove(this.referenceChanged);
      this.reference_ = undefined;
    }
  }

  private referenceChanged = (() => {
    this.validate();
    this.changed.dispatch();
  });

  private validate = (() => {
    const updatedLayer = this.updateAnnotationLayer();
    const {annotationLayer} = this;
    if (annotationLayer !== undefined) {
      const value = this.value_;
      if (value !== undefined) {
        let reference = this.reference_;
        if (reference !== undefined && reference.id !== value.id) {
          // Id changed.
          value.id = reference.id;
        } else if (reference === undefined) {
          reference = this.reference_ = annotationLayer.source.getReference(value.id);
          reference.changed.add(this.referenceChanged);
        }
        if (reference.value === null) {
          this.unbindReference();
          this.value = undefined;
          return;
        }
      } else {
        this.unbindReference();
      }
    }
    if (updatedLayer) {
      this.changed.dispatch();
    }
  });

  toJSON() {
    const value = this.value_;
    if (value === undefined) {
      return undefined;
    }
    if (value.partIndex === 0) {
      return value.id;
    }
    return value;
  }
  reset() {
    this.value = undefined;
  }
  restoreState(x: any) {
    if (x === undefined) {
      this.value = undefined;
      return;
    }
    if (typeof x === 'string') {
      this.value = {'id': x, 'partIndex': 0};
      return;
    }
    verifyObject(x);
    this.value = {
      'id': verifyObjectProperty(x, 'id', verifyString),
      'partIndex': verifyObjectProperty(x, 'partIndex', verifyOptionalInt),
    };
  }
}

const tempVec3 = vec3.create();

function makePointLink(
    point: vec3, transform: mat4, voxelSize: VoxelSize,
    setSpatialCoordinates?: (point: vec3) => void) {
  const spatialPoint = vec3.transformMat4(vec3.create(), point, transform);
  const positionText = formatIntegerPoint(voxelSize.voxelFromSpatial(tempVec3, spatialPoint));
  if (setSpatialCoordinates !== undefined) {
    const element = document.createElement('span');
    element.className = 'neuroglancer-voxel-coordinates-link';
    element.textContent = positionText;
    element.title = `Center view on voxel coordinates ${positionText}.`;
    element.addEventListener('click', () => {
      setSpatialCoordinates(spatialPoint);
    });
    return element;
  } else {
    return document.createTextNode(positionText);
  }
}

export function getPositionSummary(
    element: HTMLElement, annotation: Annotation, transform: mat4, voxelSize: VoxelSize,
    setSpatialCoordinates?: (point: vec3) => void) {
  const makePointLinkWithTransform = (point: vec3) =>
      makePointLink(point, transform, voxelSize, setSpatialCoordinates);

  switch (annotation.type) {
    case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
    case AnnotationType.LINE:
      element.appendChild(makePointLinkWithTransform(annotation.pointA));
      element.appendChild(document.createTextNode('–'));
      element.appendChild(makePointLinkWithTransform(annotation.pointB));
      break;
    case AnnotationType.POINT:
      element.appendChild(makePointLinkWithTransform(annotation.point));
      break;
    case AnnotationType.ELLIPSOID:
      element.appendChild(makePointLinkWithTransform(annotation.center));
      const transformedRadii = transformVectorByMat4(tempVec3, annotation.radii, transform);
      voxelSize.voxelFromSpatial(transformedRadii, transformedRadii);
      element.appendChild(document.createTextNode('±' + formatIntegerBounds(transformedRadii)));
      break;
    case AnnotationType.COLLECTION: {
      element.append('[');
      const amount = annotation.entries.length;
      for (let i = 0; i < amount; i++) {
        const ann = annotation.entry(i);
        getPositionSummary(element, ann, transform, voxelSize);
        if (i === amount - 1) {
          element.append(';');
        }
      }
      element.append(']');
      break;
    }
    case AnnotationType.LINE_STRIP: {
      element.append('[');
      const amount = annotation.entries.length;
      for (let i = 0; i < amount; i++) {
        const ann = annotation.entry(i);
        element.append(makePointLinkWithTransform(ann.pointA), '–');
        if (i === amount - 1) {
          element.append(makePointLinkWithTransform(ann.pointB));
        }
      }
      element.append(']');
      break;
    }
  }
}

function getCenterPosition(annotation: Annotation, transform: mat4) {
  const center = vec3.create();
  switch (annotation.type) {
    case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
    case AnnotationType.LINE:
      vec3.add(center, annotation.pointA, annotation.pointB);
      vec3.scale(center, center, 0.5);
      break;
    case AnnotationType.POINT:
      vec3.copy(center, annotation.point);
      break;
    case AnnotationType.ELLIPSOID:
      vec3.copy(center, annotation.center);
      break;
    case AnnotationType.LINE_STRIP:
    case AnnotationType.COLLECTION:
      vec3.copy(center, annotation.source);
      break;
  }
  return vec3.transformMat4(center, center, transform);
}

export class AnnotationLayerView extends Tab {
  private annotationListContainer = document.createElement('ul');
  private annotationListElements = new Map<string, HTMLElement>();
  private annotationTags = new Map<number, HTMLOptionElement>();
  private previousSelectedId: string|undefined;
  private previousHoverId: string|undefined;
  private updated = false;
  groupVisualization = this.registerDisposer(new MinimizableGroupWidget('Visualization'));
  groupAnnotations = this.registerDisposer(new MinimizableGroupWidget('Annotations'));
  // toolset

  constructor(
      public layer: Borrowed<UserLayerWithAnnotations>,
      public state: Owned<SelectedAnnotationState>,
      public annotationLayer: Owned<AnnotationLayerState>, public voxelSize: Owned<VoxelSize>,
      public setSpatialCoordinates: (point: vec3) => void) {
    super();
    this.element.classList.add('neuroglancer-annotation-layer-view');
    this.annotationListContainer.classList.add('neuroglancer-annotation-list');
    this.registerDisposer(state);
    this.registerDisposer(voxelSize);
    this.registerDisposer(annotationLayer);
    const {source} = annotationLayer;
    const updateView = () => {
      this.updated = false;
      this.updateView();
    };
    this.registerDisposer(
        source.childAdded.add((annotation) => this.addAnnotationElement(annotation)));
    this.registerDisposer(
        source.childUpdated.add((annotation) => this.updateAnnotationElement(annotation)));
    this.registerDisposer(
        source.childDeleted.add((annotationId) => this.deleteAnnotationElement(annotationId)));
    this.registerDisposer(this.visibility.changed.add(() => this.updateView()));
    this.registerDisposer(annotationLayer.transform.changed.add(updateView));
    this.updateView();

    const toolbox = document.createElement('div');
    toolbox.className = 'neuroglancer-annotation-toolbox';

    layer.initializeAnnotationLayerViewTab(this);

    {
      const widget = this.registerDisposer(new RangeWidget(this.annotationLayer.fillOpacity));
      widget.promptElement.textContent = 'Fill opacity';
      this.groupVisualization.appendFixedChild(widget.element);
    }

    const colorPicker = this.registerDisposer(new ColorWidget(this.annotationLayer.color));
    colorPicker.element.title = 'Change annotation display color';
    toolbox.appendChild(colorPicker.element);
    if (!annotationLayer.source.readonly) {
      const pointButton = document.createElement('button');
      pointButton.textContent = getAnnotationTypeHandler(AnnotationType.POINT).icon;
      pointButton.title = 'Annotate point';
      pointButton.addEventListener('click', () => {
        this.layer.tool.value = new PlacePointTool(this.layer, {});
      });
      toolbox.appendChild(pointButton);


      const boundingBoxButton = document.createElement('button');
      boundingBoxButton.textContent =
          getAnnotationTypeHandler(AnnotationType.AXIS_ALIGNED_BOUNDING_BOX).icon;
      boundingBoxButton.title = 'Annotate bounding box';
      boundingBoxButton.addEventListener('click', () => {
        this.layer.tool.value = new PlaceBoundingBoxTool(this.layer, {});
      });
      toolbox.appendChild(boundingBoxButton);


      const lineButton = document.createElement('button');
      lineButton.textContent = getAnnotationTypeHandler(AnnotationType.LINE).icon;
      lineButton.title = 'Annotate line';
      lineButton.addEventListener('click', () => {
        this.layer.tool.value = new PlaceLineTool(this.layer, {});
      });
      toolbox.appendChild(lineButton);


      const ellipsoidButton = document.createElement('button');
      ellipsoidButton.textContent = getAnnotationTypeHandler(AnnotationType.ELLIPSOID).icon;
      ellipsoidButton.title = 'Annotate ellipsoid';
      ellipsoidButton.addEventListener('click', () => {
        this.layer.tool.value = new PlaceSphereTool(this.layer, {});
      });
      toolbox.appendChild(ellipsoidButton);

      // Collections //
      /*const togglable =
          (element: HTMLElement, tglclass: string, resolve: Function, reject: Function) => {
            return () => {
              if (element.classList.toggle(tglclass)) {
                resolve();
              } else {
                reject();
              }
            };
          };*/
      const mskey = 'activeMultiStep';
      const collectionButton = document.createElement('button');
      const remActiveTool = () => {
        const keyElement = document.querySelector(`.${mskey}`);
        if (keyElement) {
          keyElement!.classList.remove(mskey);
        }
      };
      collectionButton.textContent = getAnnotationTypeHandler(AnnotationType.COLLECTION).icon;
      collectionButton.title = 'Group together multiple annotations';
      collectionButton.disabled = true;
      collectionButton.addEventListener('click', () => {});
      toolbox.appendChild(collectionButton);

      const multipointButton = document.createElement('button');
      multipointButton.textContent = getAnnotationTypeHandler(AnnotationType.LINE_STRIP).icon;
      multipointButton.title = 'Annotate multiple connected points';
      multipointButton.addEventListener('click', () => {
        if (!multipointButton.classList.contains(mskey)) {
          remActiveTool();
          multipointButton.classList.add(mskey);
          this.layer.tool.value = new PlaceLineStripTool(this.layer, {});
          const dechange = this.layer.tool.changed.add(() => {
            remActiveTool();
            dechange();
          });
        }
      });

      toolbox.appendChild(multipointButton);

      const undoMultiButton = document.createElement('button');
      {
        undoMultiButton.textContent = '↩';
        undoMultiButton.title = 'Undo previous step';
        undoMultiButton.disabled = true;
      }

      const confirmMultiButton = document.createElement('button');
      {
        confirmMultiButton.textContent = '✔️';
        confirmMultiButton.title = 'Confirm Annotation';
        confirmMultiButton.addEventListener('click', () => {
          if (this.layer.tool.value) {
            (<PlaceAnnotationTool>this.layer.tool.value).complete();
          }
        });
      }

      const abortMultiButton = document.createElement('button');
      {
        abortMultiButton.textContent = '❌';
        abortMultiButton.title = 'Abort Annotation';
        abortMultiButton.addEventListener('click', () => {
          if (this.layer.tool.value) {
            remActiveTool();
            // Not undo able, does not change state? it might but it hasn't been investigated
            StatusMessage.showTemporaryMessage(`Annotation cancelled.`, 3000);
            // HACK: force < 1 = 1
            // Expected behavior is to cancel any in progress annotations and deactivate the tool
            if (this.layer.tool.refCount < 1) {
              this.layer.tool.refCount = 1;
            }
            this.layer.tool.dispose();
            this.layer.tool.changed.dispatch();
          }
        });
      }

      toolbox.append(undoMultiButton, confirmMultiButton, abortMultiButton);
    }

    {
      const jumpingShowsSegmentationCheckbox = this.registerDisposer(
          new TrackableBooleanCheckbox(this.annotationLayer.annotationJumpingDisplaysSegmentation));
      const label = document.createElement('label');
      label.textContent = 'Bracket shortcuts show segmentation: ';
      label.appendChild(jumpingShowsSegmentationCheckbox.element);
      this.groupVisualization.appendFixedChild(label);
    }

    {
      const annotationTagFilter = document.createElement('select');
      annotationTagFilter.id = 'annotation-tag-filter';
      annotationTagFilter.add(new Option('View all', '0', true, true));
      const createOptionText = (tag: AnnotationTag) => {
        return '#' + tag.label + ' (id: ' + tag.id.toString() + ')';
      };
      for (const tag of source.getTags()) {
        const option = new Option(createOptionText(tag), tag.id.toString(), false, false);
        this.annotationTags.set(tag.id, option);
        annotationTagFilter.add(option);
      }
      this.registerDisposer(source.tagAdded.add((tag) => {
        const option = new Option(createOptionText(tag), tag.id.toString(), false, false);
        this.annotationTags.set(tag.id, option);
        annotationTagFilter.add(option);
      }));
      this.registerDisposer(source.tagUpdated.add((tag) => {
        const option = this.annotationTags.get(tag.id)!;
        option.text = createOptionText(tag);
        for (const annotation of source) {
          if (this.annotationLayer.source.isAnnotationTaggedWithTag(annotation.id, tag.id)) {
            this.updateAnnotationElement(annotation, false);
          }
        }
      }));
      this.registerDisposer(source.tagDeleted.add((tagId) => {
        annotationTagFilter.removeChild(this.annotationTags.get(tagId)!);
        this.annotationTags.delete(tagId);
        for (const annotation of source) {
          this.updateAnnotationElement(annotation, false);
        }
      }));
      annotationTagFilter.addEventListener('change', () => {
        const tagIdSelected = parseInt(annotationTagFilter.selectedOptions[0].value, 10);
        this.annotationLayer.selectedAnnotationTagId.value = tagIdSelected;
        this.filterAnnotationsByTag(tagIdSelected);
      });
      const label = document.createElement('label');
      label.textContent = 'Filter annotation list by tag: ';
      label.appendChild(annotationTagFilter);
      this.groupVisualization.appendFixedChild(label);
    }

    {
      const exportToCSVButton = document.createElement('button');
      exportToCSVButton.id = 'exportToCSVButton';
      exportToCSVButton.textContent = 'Export to CSV';
      exportToCSVButton.addEventListener('click', () => {
        this.exportToCSV();
      });
      this.groupAnnotations.appendFixedChild(exportToCSVButton);
    }

    this.groupAnnotations.appendFixedChild(toolbox);
    this.groupAnnotations.appendFlexibleChild(this.annotationListContainer);
    this.element.appendChild(this.groupVisualization.element);
    this.element.appendChild(this.groupAnnotations.element);

    this.annotationListContainer.addEventListener('mouseleave', () => {
      this.annotationLayer.hoverState.value = undefined;
    });
    this.registerDisposer(
        this.annotationLayer.hoverState.changed.add(() => this.updateHoverView()));
    this.registerDisposer(this.state.changed.add(() => this.updateSelectionView()));
  }

  private updateSelectionView() {
    const selectedValue = this.state.value;
    let newSelectedId: string|undefined;
    if (selectedValue !== undefined) {
      newSelectedId = selectedValue.id;
    }
    const {previousSelectedId} = this;
    if (newSelectedId === previousSelectedId) {
      return;
    }
    if (previousSelectedId !== undefined) {
      const element = this.annotationListElements.get(previousSelectedId);
      if (element !== undefined) {
        element.classList.remove('neuroglancer-annotation-selected');
      }
    }
    if (newSelectedId !== undefined) {
      const element = this.annotationListElements.get(newSelectedId);
      if (element !== undefined) {
        element.classList.add('neuroglancer-annotation-selected');
        element.scrollIntoView();
        // Scrolls just a pixel too far, this makes it look prettier
        this.annotationListContainer.scrollTop -= 1;
      }
    }
    this.previousSelectedId = newSelectedId;
  }

  private updateHoverView() {
    const selectedValue = this.annotationLayer.hoverState.value;
    let newHoverId: string|undefined;
    if (selectedValue !== undefined) {
      newHoverId = selectedValue.id;
    }
    const {previousHoverId} = this;
    if (newHoverId === previousHoverId) {
      return;
    }
    if (previousHoverId !== undefined) {
      const element = this.annotationListElements.get(previousHoverId);
      if (element !== undefined) {
        element.classList.remove('neuroglancer-annotation-hover');
      }
    }
    if (newHoverId !== undefined) {
      const element = this.annotationListElements.get(newHoverId);
      if (element !== undefined) {
        element.classList.add('neuroglancer-annotation-hover');
      }
    }
    this.previousHoverId = newHoverId;
  }

  private addAnnotationElementHelper(annotation: Annotation) {
    const {annotationLayer, annotationListContainer, annotationListElements} = this;
    const {objectToGlobal} = annotationLayer;

    const element = this.makeAnnotationListElement(annotation, objectToGlobal);
    annotationListContainer.appendChild(element);
    annotationListElements.set(annotation.id, element);

    element.addEventListener('mouseenter', () => {
      this.annotationLayer.hoverState.value = {id: annotation.id, partIndex: 0};
    });
    element.addEventListener('click', () => {
      this.state.value = {id: annotation.id, partIndex: 0};
    });

    element.addEventListener('mouseup', (event: MouseEvent) => {
      if (event.button === 2) {
        this.setSpatialCoordinates(
            getCenterPosition(annotation, this.annotationLayer.objectToGlobal));
      }
    });
  }

  private updateView() {
    if (!this.visible) {
      return;
    }
    if (this.updated) {
      return;
    }
    const {annotationLayer, annotationListContainer, annotationListElements} = this;
    const {source} = annotationLayer;
    removeChildren(annotationListContainer);
    annotationListElements.clear();
    for (const annotation of source) {
      this.addAnnotationElementHelper(annotation);
    }
    this.resetOnUpdate();
  }

  private addAnnotationElement(annotation: Annotation) {
    if (!this.visible) {
      return;
    }
    this.addAnnotationElementHelper(annotation);
    this.resetOnUpdate();
  }

  private updateAnnotationElement(annotation: Annotation, checkVisibility = true) {
    if (checkVisibility && !this.visible) {
      return;
    }
    var element = this.annotationListElements.get(annotation.id);
    if (!element) {
      return;
    }
    {
      const position = <HTMLElement>element.querySelector('.neuroglancer-annotation-position');
      position.innerHTML = '';
      getPositionSummary(
          position, annotation, this.annotationLayer.objectToGlobal, this.voxelSize,
          this.setSpatialCoordinates);
    }
    if (element.lastElementChild && element.children.length === 3) {
      const annotationText = this.layer.getAnnotationText(annotation);
      if (!annotationText) {
        element.removeChild(element.lastElementChild);
      } else {
        element.lastElementChild.innerHTML = annotationText;
      }
    } else {
      this.createAnnotationDescriptionElement(element, annotation);
    }
    this.resetOnUpdate();
  }

  private deleteAnnotationElement(annotationId: string) {
    if (!this.visible) {
      return;
    }
    let element = this.annotationListElements.get(annotationId);
    if (element) {
      removeFromParent(element);
      this.annotationListElements.delete(annotationId);
    }
    this.resetOnUpdate();
  }

  private resetOnUpdate() {
    this.previousSelectedId = undefined;
    this.previousHoverId = undefined;
    this.updated = true;
    this.updateHoverView();
    this.updateSelectionView();
  }

  private makeAnnotationListElement(annotation: Annotation, transform: mat4) {
    const element = document.createElement('li');
    element.title = 'Click to select, right click to recenter view.';

    const icon = document.createElement('div');
    icon.className = 'neuroglancer-annotation-icon';
    icon.textContent = getAnnotationTypeHandler(annotation.type).icon;
    element.appendChild(icon);

    const position = document.createElement('div');
    position.className = 'neuroglancer-annotation-position';
    getPositionSummary(position, annotation, transform, this.voxelSize, this.setSpatialCoordinates);
    element.appendChild(position);
    if (annotation.pid) {
      element.dataset.parent = annotation.pid;
      element.classList.add('neuroglancer-child-annotation');
    }
    this.createAnnotationDescriptionElement(element, annotation);

    return element;
  }

  private createAnnotationDescriptionElement(
      annotationElement: HTMLElement, annotation: Annotation) {
    const annotationText = this.layer.getAnnotationText(annotation);
    if (annotationText) {
      const description = document.createElement('div');
      description.className = 'neuroglancer-annotation-description';
      description.textContent = annotationText;
      annotationElement.appendChild(description);
    }
  }

  private filterAnnotationsByTag(tagId: number) {
    for (const [annotationId, annotationElement] of this.annotationListElements) {
      if (tagId === 0 ||
          this.annotationLayer.source.isAnnotationTaggedWithTag(annotationId, tagId)) {
        annotationElement.style.display = 'list-item';
      } else {
        annotationElement.style.display = 'none';
      }
    }
  }

  private exportToCSV() {
    const filename = 'annotations.csv';
    const pointToCoordinateText = (point: vec3, transform: mat4) => {
      const spatialPoint = vec3.transformMat4(vec3.create(), point, transform);
      return formatIntegerPoint(this.voxelSize.voxelFromSpatial(tempVec3, spatialPoint));
    };
    const columnHeaders = [
      'Coordinate 1', 'Coordinate 2 (if applicable)', 'Ellipsoid Dimensions (if applicable)',
      'Tags', 'Description', 'Segment IDs'
    ];
    const csvData: string[][] = [];
    for (const annotation of this.annotationLayer.source) {
      const annotationRow = [];
      let coordinate1String = '';
      let coordinate2String = '';
      let ellipsoidDimensions = '';
      switch (annotation.type) {
        case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
        case AnnotationType.LINE:
          coordinate1String =
              pointToCoordinateText(annotation.pointA, this.annotationLayer.objectToGlobal);
          coordinate2String =
              pointToCoordinateText(annotation.pointB, this.annotationLayer.objectToGlobal);
          break;
        case AnnotationType.POINT:
          coordinate1String =
              pointToCoordinateText(annotation.point, this.annotationLayer.objectToGlobal);
          break;
        case AnnotationType.ELLIPSOID:
          coordinate1String =
              pointToCoordinateText(annotation.center, this.annotationLayer.objectToGlobal);
          const transformedRadii = transformVectorByMat4(
              tempVec3, annotation.radii, this.annotationLayer.objectToGlobal);
          this.voxelSize.voxelFromSpatial(transformedRadii, transformedRadii);
          ellipsoidDimensions = formatIntegerBounds(transformedRadii);
          break;
      }
      annotationRow.push(coordinate1String);
      annotationRow.push(coordinate2String);
      annotationRow.push(ellipsoidDimensions);
      if (this.annotationLayer.source instanceof AnnotationSource && annotation.tagIds) {
        // Papa.unparse expects an array of arrays even though here we only want to create a csv for
        // one row of tags
        const annotationTags: string[][] = [[]];
        annotation.tagIds.forEach(tagId => {
          const tag = (<AnnotationSource>this.annotationLayer.source).getTag(tagId);
          if (tag) {
            annotationTags[0].push(tag.label);
          }
        });
        if (annotationTags[0].length > 0) {
          annotationRow.push(Papa.unparse(annotationTags));
        } else {
          annotationRow.push('');
        }
      } else {
        annotationRow.push('');
      }
      if (annotation.description) {
        annotationRow.push(annotation.description);
      } else {
        annotationRow.push('');
      }
      if (annotation.segments) {
        // Papa.unparse expects an array of arrays even though here we only want to create a csv for
        // one row of segments
        const annotationSegments: string[][] = [[]];
        annotation.segments.forEach(segmentID => {
          annotationSegments[0].push(segmentID.toString());
        });
        if (annotationSegments[0].length > 0) {
          annotationRow.push(Papa.unparse(annotationSegments));
        } else {
          annotationRow.push('');
        }
      }
      csvData.push(annotationRow);
    }
    const csvString = Papa.unparse({'fields': columnHeaders, 'data': csvData});
    const blob = new Blob([csvString], {type: 'text/csv;charset=utf-8;'});
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}

export class AnnotationDetailsTab extends Tab {
  private valid = false;
  private mouseEntered = false;
  private hoverState: WatchableValue<{id: string, partIndex?: number}|undefined>|undefined;
  private segmentListWidget: AnnotationSegmentListWidget|undefined;
  constructor(
      public state: Owned<SelectedAnnotationState>, public voxelSize: VoxelSize,
      public setSpatialCoordinates: (point: vec3) => void) {
    super();
    this.element.classList.add('neuroglancer-annotation-details');
    this.registerDisposer(state);
    this.registerDisposer(voxelSize);
    this.registerDisposer(this.state.changed.add(() => {
      this.valid = false;
      this.updateView();
    }));
    this.registerDisposer(this.visibility.changed.add(() => this.updateView()));
    this.state.changed.add(() => {
      this.valid = false;
      this.updateView();
    });
    this.element.addEventListener('mouseenter', () => {
      this.mouseEntered = true;
      if (this.hoverState !== undefined) {
        this.hoverState.value = this.state.value;
      }
    });
    this.element.addEventListener('mouseleave', () => {
      this.mouseEntered = false;
      if (this.hoverState !== undefined) {
        this.hoverState.value = undefined;
      }
    });
    this.updateView();
  }

  private updateView() {
    if (!this.visible) {
      this.element.style.display = 'none';
      this.hoverState = undefined;
      return;
    }
    this.element.style.display = null;
    if (this.valid) {
      return;
    }
    const {element} = this;
    removeChildren(element);
    this.valid = true;
    const {reference} = this.state;
    if (reference === undefined) {
      return;
    }
    const value = this.state.value!;
    const annotation = reference.value;
    if (annotation == null) {
      return;
    }
    const annotationLayer = this.state.annotationLayerState.value!;
    this.hoverState = annotationLayer.hoverState;
    if (this.mouseEntered) {
      this.hoverState.value = value;
    }

    const {objectToGlobal} = annotationLayer;
    const {voxelSize} = this;

    const handler = getAnnotationTypeHandler(annotation.type);

    const title = document.createElement('div');
    title.className = 'neuroglancer-annotation-details-title';

    const icon = document.createElement('div');
    icon.className = 'neuroglancer-annotation-details-icon';
    icon.textContent = handler.icon;

    const titleText = document.createElement('div');
    titleText.className = 'neuroglancer-annotation-details-title-text';
    titleText.textContent = `${handler.description}`;
    title.appendChild(icon);
    title.appendChild(titleText);

    if (!annotationLayer.source.readonly) {
      const deleteButton = makeTextIconButton('🗑', 'Delete annotation');
      deleteButton.addEventListener('click', () => {
        const ref = annotationLayer.source.getReference(value.id);
        try {
          annotationLayer.source.delete(ref);
        } finally {
          ref.dispose();
        }
      });
      title.appendChild(deleteButton);
    }

    const closeButton = makeCloseButton();
    closeButton.title = 'Hide annotation details';
    closeButton.addEventListener('click', () => {
      this.state.value = undefined;
    });
    title.appendChild(closeButton);

    element.appendChild(title);

    const position = document.createElement('div');
    position.className = 'neuroglancer-annotation-details-position';
    getPositionSummary(position, annotation, objectToGlobal, voxelSize, this.setSpatialCoordinates);
    element.appendChild(position);

    if (annotation.type === AnnotationType.AXIS_ALIGNED_BOUNDING_BOX) {
      const volume = document.createElement('div');
      volume.className = 'neuroglancer-annotation-details-volume';
      volume.textContent =
          formatBoundingBoxVolume(annotation.pointA, annotation.pointB, objectToGlobal);
      element.appendChild(volume);

      // FIXME: only do this if it is axis aligned
      const spatialOffset = transformVectorByMat4(
          tempVec3, vec3.subtract(tempVec3, annotation.pointA, annotation.pointB), objectToGlobal);
      const voxelVolume = document.createElement('div');
      voxelVolume.className = 'neuroglancer-annotation-details-volume-in-voxels';
      const voxelOffset = voxelSize.voxelFromSpatial(tempVec3, spatialOffset);
      voxelVolume.textContent = `${formatIntegerBounds(voxelOffset)}`;
      element.appendChild(voxelVolume);
    } else if (annotation.type === AnnotationType.LINE) {
      const spatialOffset = transformVectorByMat4(
          tempVec3, vec3.subtract(tempVec3, annotation.pointA, annotation.pointB), objectToGlobal);
      const length = document.createElement('div');
      length.className = 'neuroglancer-annotation-details-length';
      const spatialLengthText = formatLength(vec3.length(spatialOffset));
      let voxelLengthText = '';
      if (voxelSize.valid) {
        const voxelLength = vec3.length(voxelSize.voxelFromSpatial(tempVec3, spatialOffset));
        voxelLengthText = `, ${Math.round(voxelLength)} vx`;
      }
      length.textContent = spatialLengthText + voxelLengthText;
      element.appendChild(length);
    }

    let {segmentListWidget} = this;
    if (segmentListWidget !== undefined) {
      if (segmentListWidget.reference !== reference) {
        segmentListWidget.dispose();
        this.unregisterDisposer(segmentListWidget);
        segmentListWidget = this.segmentListWidget = undefined;
      }
    }
    if (segmentListWidget === undefined) {
      this.segmentListWidget = segmentListWidget =
          this.registerDisposer(new AnnotationSegmentListWidget(reference, annotationLayer));
    }
    element.appendChild(segmentListWidget.element);

    const description = document.createElement('textarea');
    description.value = annotation.description || '';
    description.rows = 3;
    description.className = 'neuroglancer-annotation-details-description';
    description.placeholder = 'Description';
    if (annotationLayer.source.readonly) {
      description.readOnly = true;
    } else {
      description.addEventListener('change', () => {
        const x = description.value;
        annotationLayer.source.update(reference, {...annotation, description: x ? x : undefined});
        annotationLayer.source.commit(reference);
      });
    }
    element.appendChild(description);
  }
}

export class AnnotationTab extends Tab {
  private stack = this.registerDisposer(
      new StackView<AnnotationLayerState, AnnotationLayerView>(annotationLayerState => {
        return new AnnotationLayerView(
            this.layer, this.state.addRef(), annotationLayerState.addRef(), this.voxelSize.addRef(),
            this.setSpatialCoordinates);
      }, this.visibility));
  private detailsTab = this.registerDisposer(
      new AnnotationDetailsTab(this.state, this.voxelSize.addRef(), this.setSpatialCoordinates));
  constructor(
      public layer: Borrowed<UserLayerWithAnnotations>,
      public state: Owned<SelectedAnnotationState>, public voxelSize: Owned<VoxelSize>,
      public setSpatialCoordinates: (point: vec3) => void) {
    super();
    this.registerDisposer(state);
    this.registerDisposer(voxelSize);
    const {element} = this;
    element.classList.add('neuroglancer-annotations-tab');
    this.stack.element.classList.add('neuroglancer-annotations-stack');
    element.appendChild(this.stack.element);
    element.appendChild(this.detailsTab.element);
    const updateDetailsVisibility = () => {
      this.detailsTab.visibility.value = this.state.validValue !== undefined && this.visible ?
          WatchableVisibilityPriority.VISIBLE :
          WatchableVisibilityPriority.IGNORED;
    };
    this.registerDisposer(this.state.changed.add(updateDetailsVisibility));
    this.registerDisposer(this.visibility.changed.add(updateDetailsVisibility));
    const setAnnotationLayerView = () => {
      this.stack.selected = this.state.annotationLayerState.value;
    };
    this.registerDisposer(this.state.annotationLayerState.changed.add(setAnnotationLayerView));
    setAnnotationLayerView();
  }
}

function getSelectedAssocatedSegment(annotationLayer: AnnotationLayerState) {
  let segments: Uint64[]|undefined;
  const segmentationState = annotationLayer.segmentationState.value;
  if (segmentationState != null) {
    if (segmentationState.segmentSelectionState.hasSelectedSegment) {
      segments = [segmentationState.segmentSelectionState.selectedSegment.clone()];
    }
  }
  return segments;
}

abstract class PlaceAnnotationTool extends Tool {
  temp?: Annotation;
  group: string;
  annotationDescription: string|undefined;
  constructor(public layer: UserLayerWithAnnotations, options: any) {
    super();
    if (layer.annotationLayerState === undefined) {
      throw new Error(`Invalid layer for annotation tool.`);
    }
    this.annotationDescription = verifyObjectProperty(options, 'description', verifyOptionalString);
  }

  get annotationLayer() {
    return this.layer.annotationLayerState.value;
  }

  complete() {
    StatusMessage.showTemporaryMessage(`Only supported in collection annotations.`, 3000);
  }
}

const ANNOTATE_POINT_TOOL_ID = 'annotatePoint';
const ANNOTATE_LINE_TOOL_ID = 'annotateLine';
const ANNOTATE_LINE_STRIP_TOOL_ID = 'annotateLineStrip';
const ANNOTATE_BOUNDING_BOX_TOOL_ID = 'annotateBoundingBox';
const ANNOTATE_ELLIPSOID_TOOL_ID = 'annotateSphere';

export class PlacePointTool extends PlaceAnnotationTool {
  constructor(layer: UserLayerWithAnnotations, options: any) {
    super(layer, options);
  }

  trigger(mouseState: MouseSelectionState, parentRef?: AnnotationReference) {
    const {annotationLayer} = this;
    if (annotationLayer === undefined) {
      // Not yet ready.
      return;
    }
    if (mouseState.active) {
      const annotation: Annotation = {
        id: '',
        description: '',
        segments: getSelectedAssocatedSegment(annotationLayer),
        point:
            vec3.transformMat4(vec3.create(), mouseState.position, annotationLayer.globalToObject),
        type: AnnotationType.POINT,
      };
      if (parentRef) {
        annotation.pid = parentRef.id;
        annotation.cix = (<Collection>parentRef.value!).entries.length;
      }
      const reference = annotationLayer.source.add(annotation, /*commit=*/true);
      this.layer.selectedAnnotation.value = {id: reference.id};
      if (parentRef) {
        (<Collection>parentRef.value!).entries.push(reference.id);
      }
      reference.dispose();
    }
  }

  get description() {
    return `annotate point`;
  }

  toJSON() {
    return ANNOTATE_POINT_TOOL_ID;
  }
}

function getMousePositionInAnnotationCoordinates(
    mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState) {
  return vec3.transformMat4(vec3.create(), mouseState.position, annotationLayer.globalToObject);
}

abstract class TwoStepAnnotationTool extends PlaceAnnotationTool {
  inProgressAnnotation:
      {annotationLayer: AnnotationLayerState, reference: AnnotationReference, disposer: () => void}|
      undefined;

  abstract getInitialAnnotation(
      mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState): Annotation;
  abstract getUpdatedAnnotation(
      oldAnnotation: Annotation, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState): Annotation;

  trigger(mouseState: MouseSelectionState, parentRef?: AnnotationReference) {
    const {annotationLayer} = this;
    if (annotationLayer === undefined) {
      // Not yet ready.
      return;
    }
    if (mouseState.active) {
      const updatePointB = () => {
        const state = this.inProgressAnnotation!;
        const reference = state.reference;
        const newAnnotation =
            this.getUpdatedAnnotation(reference.value!, mouseState, annotationLayer);
        state.annotationLayer.source.update(reference, newAnnotation);
        this.layer.selectedAnnotation.value = {id: reference.id};
      };

      if (this.inProgressAnnotation === undefined) {
        const annotation = this.getInitialAnnotation(mouseState, annotationLayer);
        if (parentRef) {
          annotation.pid = parentRef.id;
          annotation.cix = (<Collection>parentRef.value!).entries.length;
        }
        const reference = annotationLayer.source.add(annotation, /*commit=*/false);
        if (parentRef) {
          (<Collection>parentRef.value!).entries.push(reference.id);
        }
        this.layer.selectedAnnotation.value = {id: reference.id};
        const disposer = () => {
          mouseDisposer();
          reference.dispose();
        };
        this.inProgressAnnotation = {
          annotationLayer,
          reference,
          disposer,
        };
        const mouseDisposer = mouseState.changed.add(updatePointB);
      } else {
        updatePointB();
        if (this.inProgressAnnotation) {
          this.inProgressAnnotation.annotationLayer.source.commit(
              this.inProgressAnnotation.reference);
          this.inProgressAnnotation.disposer();
          this.inProgressAnnotation = undefined;
        }
      }
    }
  }

  disposed() {
    this.deactivate();
    super.disposed();
  }

  deactivate() {
    if (this.inProgressAnnotation !== undefined) {
      this.inProgressAnnotation.annotationLayer.source.delete(this.inProgressAnnotation.reference);
      this.inProgressAnnotation.disposer();
      this.inProgressAnnotation = undefined;
    }
  }
}

abstract class PlaceTwoCornerAnnotationTool extends TwoStepAnnotationTool {
  annotationType: AnnotationType.LINE|AnnotationType.AXIS_ALIGNED_BOUNDING_BOX;

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
    return <AxisAlignedBoundingBox|Line>{
      id: '',
      type: this.annotationType,
      description: '',
      pointA: point,
      pointB: point,
    };
  }

  getUpdatedAnnotation(
      oldAnnotation: AxisAlignedBoundingBox|Line, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState): Annotation {
    const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
    return {...oldAnnotation, pointB: point};
  }
}

abstract class MultiStepAnnotationTool extends TwoStepAnnotationTool {
  annotationType: AnnotationType.COLLECTION|AnnotationType.LINE_STRIP;
  toolset: typeof PlacePointTool|typeof PlaceBoundingBoxTool|typeof PlaceLineTool|
      typeof PlaceSphereTool;
  childTool: PlacePointTool|PlaceBoundingBoxTool|PlaceLineTool|PlaceSphereTool;

  getUpdatedAnnotation(
      oldAnnotation: LineStrip, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState) {
    if (0) {
      console.log(oldAnnotation, mouseState, annotationLayer);
    }
    return oldAnnotation;
  }

  initChildAnnotation() {
    if (!(this.childTool instanceof PlacePointTool)) {
      const inProgressAnnotation = (<TwoStepAnnotationTool>this.childTool).inProgressAnnotation;
      // Child should not be a collection (for now)
      const child = inProgressAnnotation!.reference;
      const disposer = inProgressAnnotation!.disposer;
      inProgressAnnotation!.disposer = () => {
        // for every child annotation, redefine its disposer to call the parent to push to the entry
        // list
        disposer();
      };
      return child;
    }
    return;
  }

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const coll = <Collection>{
      id: '',
      type: this.annotationType,
      description: '',
      entries: [],
      looped: false,
      connected: false,
      source:
          vec3.transformMat4(vec3.create(), mouseState.position, annotationLayer.globalToObject),
      entry: () => {}
    };
    coll.entry = (index: number) =>
        (<LocalAnnotationSource>annotationLayer.source).get(coll.entries[index]);
    return coll;
  }

  appendNewChildAnnotation(
      oldAnnotationRef: AnnotationReference, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState): Annotation {
    if (0) {
      console.log(mouseState, annotationLayer);
    }

    const oldAnnotation = <Collection>oldAnnotationRef!.value!;
    this.childTool = new this.toolset(this.layer, {});
    this.childTool.trigger(mouseState, oldAnnotationRef);

    // append new annotation into last
    let last = this.initChildAnnotation();
    // TODO: Evaluate
    return {...oldAnnotation, last};
  }


  complete() {
    if (this.inProgressAnnotation) {
      (<Collection>this.inProgressAnnotation.reference.value!).entries.pop();
      this.inProgressAnnotation.annotationLayer.source.commit(this.inProgressAnnotation.reference);
      this.inProgressAnnotation.disposer();
      this.inProgressAnnotation = undefined;
      this.childTool.dispose();
    } else {
      StatusMessage.showTemporaryMessage(`No annotation has been made.`, 3000);
    }
  }

  trigger(mouseState: MouseSelectionState) {
    // TODO: Move to line strip
    const {annotationLayer} = this;
    if (annotationLayer === undefined) {
      // Not yet ready.
      return;
    }
    if (!this.childTool) {
      return;
    }
    if (mouseState.active) {
      if (this.inProgressAnnotation === undefined) {
        const reference = annotationLayer.source.add(
            this.getInitialAnnotation(mouseState, annotationLayer), /*commit=*/false);
        this.layer.selectedAnnotation.value = {id: reference.id};
        this.childTool.trigger(mouseState, /*child=*/reference);

        const mouseDisposer = () => {};
        const disposer = () => {
          mouseDisposer();
          reference.dispose();
        };
        this.inProgressAnnotation = {
          annotationLayer,
          reference,
          disposer,
        };
      } else {
        this.childTool.trigger(mouseState, this.inProgressAnnotation.reference);
        this.appendNewChildAnnotation(
            this.inProgressAnnotation.reference!, mouseState, annotationLayer);
        // updateChild();
      }
    }
  }
}

export class PlaceLineStripTool extends MultiStepAnnotationTool {
  toolset = PlaceLineTool;
  constructor(public layer: UserLayerWithAnnotations, options: any) {
    super(layer, options);
    this.childTool = new this.toolset(layer, options);
  }

  get description() {
    return `annotate line strip`;
  }

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const result = super.getInitialAnnotation(mouseState, annotationLayer);
    result.segments = getSelectedAssocatedSegment(annotationLayer);
    return result;
  }

  toJSON() {
    return ANNOTATE_LINE_STRIP_TOOL_ID;
  }
}
PlaceLineStripTool.prototype.annotationType = AnnotationType.LINE_STRIP;

export class PlaceBoundingBoxTool extends PlaceTwoCornerAnnotationTool {
  get description() {
    return `annotate bounding box`;
  }

  toJSON() {
    return ANNOTATE_BOUNDING_BOX_TOOL_ID;
  }
}
PlaceBoundingBoxTool.prototype.annotationType = AnnotationType.AXIS_ALIGNED_BOUNDING_BOX;

export class PlaceLineTool extends PlaceTwoCornerAnnotationTool {
  get description() {
    return `annotate line`;
  }

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const result = super.getInitialAnnotation(mouseState, annotationLayer);
    result.segments = getSelectedAssocatedSegment(annotationLayer);
    return result;
  }

  getUpdatedAnnotation(
      oldAnnotation: Line|AxisAlignedBoundingBox, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState) {
    const result = super.getUpdatedAnnotation(oldAnnotation, mouseState, annotationLayer);
    const segments = result.segments;
    if (segments !== undefined && segments.length > 0) {
      segments.length = 1;
    }
    let newSegments = getSelectedAssocatedSegment(annotationLayer);
    if (newSegments && segments) {
      newSegments = newSegments.filter(x => segments.findIndex(y => Uint64.equal(x, y)) === -1);
    }
    result.segments = [...(segments || []), ...(newSegments || [])] || undefined;
    return result;
  }

  toJSON() {
    return ANNOTATE_LINE_TOOL_ID;
  }
}
PlaceLineTool.prototype.annotationType = AnnotationType.LINE;

class PlaceSphereTool extends TwoStepAnnotationTool {
  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);

    return <Ellipsoid>{
      type: AnnotationType.ELLIPSOID,
      id: '',
      description: '',
      segments: getSelectedAssocatedSegment(annotationLayer),
      center: point,
      radii: vec3.fromValues(0, 0, 0),
    };
  }

  getUpdatedAnnotation(
      oldAnnotation: Ellipsoid, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState) {
    const spatialCenter =
        vec3.transformMat4(vec3.create(), oldAnnotation.center, annotationLayer.objectToGlobal);

    const radius = vec3.distance(spatialCenter, mouseState.position);

    const tempMatrix = mat3.create();
    tempMatrix[0] = tempMatrix[4] = tempMatrix[8] = 1 / (radius * radius);


    const objectToGlobalLinearTransform =
        mat3FromMat4(mat3.create(), annotationLayer.objectToGlobal);
    mat3.multiply(tempMatrix, tempMatrix, objectToGlobalLinearTransform);
    mat3.transpose(objectToGlobalLinearTransform, objectToGlobalLinearTransform);
    mat3.multiply(tempMatrix, objectToGlobalLinearTransform, tempMatrix);

    return <Ellipsoid>{
      ...oldAnnotation,
      radii: vec3.fromValues(
          1 / Math.sqrt(tempMatrix[0]), 1 / Math.sqrt(tempMatrix[4]), 1 / Math.sqrt(tempMatrix[8])),
    };
  }
  get description() {
    return `annotate ellipsoid`;
  }

  toJSON() {
    return ANNOTATE_ELLIPSOID_TOOL_ID;
  }
}

registerTool(
    ANNOTATE_POINT_TOOL_ID,
    (layer, options) => new PlacePointTool(<UserLayerWithAnnotations>layer, options));
registerTool(
    ANNOTATE_BOUNDING_BOX_TOOL_ID,
    (layer, options) => new PlaceBoundingBoxTool(<UserLayerWithAnnotations>layer, options));
registerTool(
    ANNOTATE_LINE_TOOL_ID,
    (layer, options) => new PlaceLineTool(<UserLayerWithAnnotations>layer, options));
registerTool(
    ANNOTATE_ELLIPSOID_TOOL_ID,
    (layer, options) => new PlaceSphereTool(<UserLayerWithAnnotations>layer, options));
/*registerTool(
    ANNOTATE_LINE_STRIP_TOOL_ID,
    (layer, options) => new PlaceCollectionTool(<UserLayerWithAnnotations>layer, options));*/
registerTool(
    ANNOTATE_LINE_STRIP_TOOL_ID,
    (layer, options) => new PlaceLineStripTool(<UserLayerWithAnnotations>layer, options));

export interface UserLayerWithAnnotations extends UserLayer {
  annotationLayerState: WatchableRefCounted<AnnotationLayerState>;
  selectedAnnotation: SelectedAnnotationState;
  annotationColor: TrackableRGB;
  annotationFillOpacity: TrackableAlphaValue;
  initializeAnnotationLayerViewTab(tab: AnnotationLayerView): void;
  getAnnotationText(annotation: Annotation): string;
}

export function getAnnotationRenderOptions(userLayer: UserLayerWithAnnotations) {
  return {color: userLayer.annotationColor, fillOpacity: userLayer.annotationFillOpacity};
}

const SELECTED_ANNOTATION_JSON_KEY = 'selectedAnnotation';
const ANNOTATION_COLOR_JSON_KEY = 'annotationColor';
const ANNOTATION_FILL_OPACITY_JSON_KEY = 'annotationFillOpacity';
export function UserLayerWithAnnotationsMixin<TBase extends {new (...args: any[]): UserLayer}>(
    Base: TBase) {
  abstract class C extends Base implements UserLayerWithAnnotations {
    annotationLayerState = this.registerDisposer(new WatchableRefCounted<AnnotationLayerState>());
    selectedAnnotation =
        this.registerDisposer(new SelectedAnnotationState(this.annotationLayerState.addRef()));
    annotationColor = new TrackableRGB(vec3.fromValues(1, 1, 0));
    annotationFillOpacity = trackableAlphaValue(0.0);
    constructor(...args: any[]) {
      super(...args);
      this.selectedAnnotation.changed.add(this.specificationChanged.dispatch);
      this.annotationColor.changed.add(this.specificationChanged.dispatch);
      this.annotationFillOpacity.changed.add(this.specificationChanged.dispatch);
      this.tabs.add('annotations', {
        label: 'Annotations',
        order: 10,
        getter: () => new AnnotationTab(
            this, this.selectedAnnotation.addRef(), this.manager.voxelSize.addRef(),
            point => this.manager.setSpatialCoordinates(point))
      });
      this.annotationLayerState.changed.add(() => {
        const state = this.annotationLayerState.value;
        if (state !== undefined) {
          const annotationLayer = new AnnotationLayer(this.manager.chunkManager, state.addRef());
          setAnnotationHoverStateFromMouseState(state, this.manager.layerSelectedValues.mouseState);
          this.addRenderLayer(new SliceViewAnnotationLayer(annotationLayer));
          this.addRenderLayer(new PerspectiveViewAnnotationLayer(annotationLayer.addRef()));
          if (annotationLayer.source instanceof MultiscaleAnnotationSource) {
            const dataFetchLayer = this.registerDisposer(
                new DataFetchSliceViewRenderLayer(annotationLayer.source.addRef()));
            this.registerDisposer(registerNested(state.filterBySegmentation, (context, value) => {
              if (!value) {
                this.addRenderLayer(dataFetchLayer.addRef());
                context.registerDisposer(() => this.removeRenderLayer(dataFetchLayer));
              }
            }));
          }
        }
      });
    }

    restoreState(specification: any) {
      super.restoreState(specification);
      this.selectedAnnotation.restoreState(specification[SELECTED_ANNOTATION_JSON_KEY]);
      this.annotationColor.restoreState(specification[ANNOTATION_COLOR_JSON_KEY]);
      this.annotationFillOpacity.restoreState(specification[ANNOTATION_FILL_OPACITY_JSON_KEY]);
    }

    toJSON() {
      const x = super.toJSON();
      x[SELECTED_ANNOTATION_JSON_KEY] = this.selectedAnnotation.toJSON();
      x[ANNOTATION_COLOR_JSON_KEY] = this.annotationColor.toJSON();
      x[ANNOTATION_FILL_OPACITY_JSON_KEY] = this.annotationFillOpacity.toJSON();
      return x;
    }

    initializeAnnotationLayerViewTab(tab: AnnotationLayerView) {
      tab;
    }

    getAnnotationText(annotation: Annotation) {
      return annotation.description || '';
    }
  }
  return C;
}
