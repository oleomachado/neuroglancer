/**
 * @license
 * Copyright 2016 Google Inc.
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

import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {partitionArray} from 'neuroglancer/util/array';
import {approxEqual} from 'neuroglancer/util/compare';
import {DATA_TYPE_BYTES, DataType} from 'neuroglancer/util/data_type';
import {effectiveScalingFactorFromMat4, identityMat4, kAxes, kInfinityVec, kZeroVec, mat4, rectifyTransformMatrixIfAxisAligned, transformVectorByMat4, vec3} from 'neuroglancer/util/geom';
import {SharedObject} from 'neuroglancer/worker_rpc';
import {TrackableMIPLevelConstraints} from 'neuroglancer/trackable_mip_level_constraints';
import {TrackableValue} from 'neuroglancer/trackable_value';

export {DATA_TYPE_BYTES, DataType};
export type GlobalCoordinateRectangle = [vec3, vec3, vec3, vec3];

const DEBUG_CHUNK_INTERSECTIONS = false;
const DEBUG_VISIBLE_SOURCES = false;

const tempVec3 = vec3.create();

/**
 * Average cross-sectional area contained within a chunk of the specified size and rotation.
 *
 * This is estimated by taking the total volume of the chunk and dividing it by the total length of
 * the chunk along the z axis.
 */
function estimateSliceAreaPerChunk(zAxis: vec3, chunkLayout: ChunkLayout) {
  const chunkSize = chunkLayout.size;
  const zAxisRotated = chunkLayout.globalToLocalSpatialVector(tempVec3, zAxis);

  // Minimum and maximum dot product of zAxisRotated with each of the corners of the chunk.  Both
  // are initialized to 0 because the origin of the chunk has a projection of 0.
  let minProjection = 0, maxProjection = 0;
  let chunkVolume = 1;
  for (let i = 0; i < 3; ++i) {
    const chunkSizeValue = chunkSize[i];
    chunkVolume *= chunkSizeValue;
    const projection = chunkSizeValue * zAxisRotated[i];
    minProjection = Math.min(minProjection, projection);
    maxProjection = Math.max(maxProjection, projection);
  }
  const projectionLength = maxProjection - minProjection;
  return chunkVolume / projectionLength;
}

/**
 * All valid chunks are in the range [lowerBound, upperBound).
 *
 * @param lowerBound Output parameter for lowerBound.
 * @param upperBound Output parameter for upperBound.
 * @param sources Sources for which to compute the chunk bounds.
 */
function computeSourcesChunkBounds(
    sourcesLowerBound: vec3, sourcesUpperBound: vec3, sources: Iterable<SliceViewChunkSource>) {
  for (let i = 0; i < 3; ++i) {
    sourcesLowerBound[i] = Number.POSITIVE_INFINITY;
    sourcesUpperBound[i] = Number.NEGATIVE_INFINITY;
  }

  for (let source of sources) {
    let {spec} = source;
    let {lowerChunkBound, upperChunkBound} = spec;
    for (let i = 0; i < 3; ++i) {
      sourcesLowerBound[i] = Math.min(sourcesLowerBound[i], lowerChunkBound[i]);
      sourcesUpperBound[i] = Math.max(sourcesUpperBound[i], upperChunkBound[i]);
    }
  }
}

enum BoundsComparisonResult {
  // Needle is fully outside haystack.
  FULLY_OUTSIDE,
  // Needle is fully inside haystack.
  FULLY_INSIDE,
  // Needle is partially inside haystack.
  PARTIALLY_INSIDE
}

function compareBoundsSingleDimension(
    needleLower: number, needleUpper: number, haystackLower: number, haystackUpper: number) {
  if (needleLower >= haystackUpper || needleUpper <= haystackLower) {
    return BoundsComparisonResult.FULLY_OUTSIDE;
  }
  if (needleLower >= haystackLower && needleUpper <= haystackUpper) {
    return BoundsComparisonResult.FULLY_INSIDE;
  }
  return BoundsComparisonResult.PARTIALLY_INSIDE;
}

function compareBounds(
    needleLowerBound: vec3, needleUpperBound: vec3, haystackLowerBound: vec3,
    haystackUpperBound: vec3) {
  let curResult = BoundsComparisonResult.FULLY_INSIDE;
  for (let i = 0; i < 3; ++i) {
    let newResult = compareBoundsSingleDimension(
        needleLowerBound[i], needleUpperBound[i], haystackLowerBound[i], haystackUpperBound[i]);
    switch (newResult) {
      case BoundsComparisonResult.FULLY_OUTSIDE:
        return newResult;
      case BoundsComparisonResult.PARTIALLY_INSIDE:
        curResult = newResult;
        break;
    }
  }
  return curResult;
}

function areBoundsInvalid(lowerBound: vec3, upperBound: vec3) {
  for (let i = 0; i < 3; ++i) {
    if (lowerBound[i] > upperBound[i]) {
      return true;
    }
  }
  return false;
}

export interface TransformedSource<Source extends SliceViewChunkSource = SliceViewChunkSource> {
  source: Source;
  chunkLayout: ChunkLayout;
  voxelSize: vec3;
}

export interface RenderLayer<Source extends SliceViewChunkSource> {
  sources: Source[][];
  transform: CoordinateTransform;
  transformedSources: TransformedSource<Source>[][]|undefined;
  transformedSourcesGeneration: number;
  mipLevelConstraints: TrackableMIPLevelConstraints;
  activeMinMIPLevel?: TrackableValue<number|undefined>; // not needed for backend
}

export function getTransformedSources<Source extends SliceViewChunkSource>(
    renderLayer: RenderLayer<Source>) {
  const {transform} = renderLayer;
  let {transformedSources} = renderLayer;
  const generation = transform.changed.count;
  if (generation !== renderLayer.transformedSourcesGeneration) {
    renderLayer.transformedSourcesGeneration = generation;
    if (mat4.equals(transform.transform, identityMat4)) {
      transformedSources = renderLayer.sources.map(
          alternatives => alternatives.map(source => ({
                                             source,
                                             chunkLayout: source.spec.chunkLayout,
                                             voxelSize: source.spec.voxelSize
                                           })));
    } else {
      transformedSources = renderLayer.sources.map(alternatives => alternatives.map(source => {
        const chunkLayout = source.spec.chunkLayout;
        const transformedChunkLayout = ChunkLayout.get(
            chunkLayout.size, getCombinedTransform(chunkLayout.transform, transform));
        return {
          chunkLayout: transformedChunkLayout,
          source,
          voxelSize: transformedChunkLayout.localSpatialVectorToGlobal(
              vec3.create(), source.spec.voxelSize),
        };
      }));
    }
    renderLayer.transformedSources = transformedSources;
  }
  return transformedSources!;
}

function pickBestAlternativeSource<Source extends SliceViewChunkSource>(
    zAxis: vec3, alternatives: TransformedSource<Source>[]) {
  let numAlternatives = alternatives.length;
  let bestAlternativeIndex = 0;
  if (DEBUG_VISIBLE_SOURCES) {
    console.log(alternatives);
  }
  if (numAlternatives > 1) {
    let bestSliceArea = 0;
    for (let alternativeIndex = 0; alternativeIndex < numAlternatives; ++alternativeIndex) {
      let alternative = alternatives[alternativeIndex];
      const {chunkLayout} = alternative;
      let sliceArea = estimateSliceAreaPerChunk(zAxis, chunkLayout);
      if (DEBUG_VISIBLE_SOURCES) {
        console.log(`zAxis = ${zAxis}, chunksize = ${chunkLayout.size}, sliceArea = ${sliceArea}`);
      }
      if (sliceArea > bestSliceArea) {
        bestSliceArea = sliceArea;
        bestAlternativeIndex = alternativeIndex;
      }
    }
  }
  return alternatives[bestAlternativeIndex];
}

const tempGlobalRectangle: GlobalCoordinateRectangle = [vec3.create(), vec3.create(), vec3.create(), vec3.create()];

export class SliceViewBase<Source extends SliceViewChunkSource,
                                          RLayer extends RenderLayer<Source>> extends SharedObject {
  width = -1;
  height = -1;
  hasViewportToData = false;
  /**
   * Specifies whether width, height, and viewportToData are valid.
   */
  hasValidViewport = false;

  // Transforms (x,y) viewport coordinates in the range:
  //
  // x=[left: -width/2, right: width/2] and
  //
  // y=[top: -height/2, bottom: height/2],
  //
  // to data coordinates.
  viewportToData = mat4.create();

  // Normalized x, y, and z viewport axes in data coordinate space.
  viewportAxes = [vec3.create(), vec3.create(), vec3.create()];

  // Viewport axes used for selecting visible sources.
  previousViewportAxes = [vec3.create(), vec3.create()];

  centerDataPosition = vec3.create();

  viewportPlaneDistanceToOrigin: number = 0;

  /**
   * For each visible ChunkLayout, maps each visible GenericVolumeChunkSource to its priority index.
   * Overall chunk priority ordering is based on a lexicographical ordering of (priorityIndex,
   * -distanceToCenter).
   */
  visibleChunkLayouts = new Map<ChunkLayout, Map<Source, number>>();

  visibleLayers = new Map<RLayer, TransformedSource<Source>[]>();

  visibleSourcesStale = true;

  /**
   * Size in spatial units (nm) of a single pixel.
   */
  pixelSize: number = 0;

  constructor() {
    super();
    mat4.identity(this.viewportToData);
  }

  /**
   * Called when hasValidViewport == true and the viewport width/height or data transform matrix
   * changes.
   */
  onViewportChanged() {}
  maybeSetHasValidViewport() {
    if (!this.hasValidViewport && this.width !== -1 && this.height !== -1 &&
        this.hasViewportToData) {
      this.hasValidViewport = true;
      this.onHasValidViewport();
    }
    if (this.hasValidViewport) {
      this.onViewportChanged();
    }
  }
  onHasValidViewport() {}
  setViewportSize(width: number, height: number) {
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.maybeSetHasValidViewport();
      return true;
    }
    return false;
  }
  setViewportToDataMatrix(mat: mat4) {
    if (this.hasViewportToData && mat4.equals(this.viewportToData, mat)) {
      return false;
    }

    this.hasViewportToData = true;

    let {viewportToData} = this;
    mat4.copy(viewportToData, mat);
    rectifyTransformMatrixIfAxisAligned(viewportToData);
    vec3.transformMat4(this.centerDataPosition, kZeroVec, mat);

    // Initialize to zero to avoid confusing TypeScript compiler.
    let newPixelSize = 0;

    // Swap previousViewportAxes with viewportAxes.
    let viewportAxes = this.viewportAxes;
    let previousViewportAxes = this.previousViewportAxes;

    // Compute axes.
    for (var i = 0; i < 3; ++i) {
      let a = viewportAxes[i];
      transformVectorByMat4(a, kAxes[i], viewportToData);
      // a[3] is guaranteed to be 0.
      if (i === 0) {
        newPixelSize = vec3.length(a);
      }
      vec3.normalize(a, a);
    }

    this.viewportAxes = viewportAxes;
    this.previousViewportAxes = previousViewportAxes;

    if (!approxEqual(newPixelSize, this.pixelSize) ||
        (vec3.dot(viewportAxes[0], previousViewportAxes[0]) < 0.95) ||
        (vec3.dot(viewportAxes[1], previousViewportAxes[1]) < 0.95)) {
      vec3.copy(previousViewportAxes[0], viewportAxes[0]);
      vec3.copy(previousViewportAxes[1], viewportAxes[1]);
      this.visibleSourcesStale = true;
      this.pixelSize = newPixelSize;
    }

    // Compute viewport plane distance to origin.
    this.viewportPlaneDistanceToOrigin = vec3.dot(this.centerDataPosition, this.viewportAxes[2]);
    this.onViewportToDataMatrixChanged();
    this.maybeSetHasValidViewport();
    return true;
  }

  onViewportToDataMatrixChanged() {}

  /**
   * Computes the list of sources to use for each visible layer, based on the
   * current pixelSize, and the user specified integers minMIPLevel and maxMIPLevel.
   */
  updateVisibleSources() {
    if (!this.visibleSourcesStale) {
      return;
    }
    this.visibleSourcesStale = false;
    // Increase pixel size by a small margin.
    const pixelSize = this.pixelSize * 1.1;
    // console.log("pixelSize", pixelSize);

    const visibleChunkLayouts = this.visibleChunkLayouts;
    const zAxis = this.viewportAxes[2];

    const visibleLayers = this.visibleLayers;
    visibleChunkLayouts.clear();
    for (const [renderLayer, visibleSources] of visibleLayers) {
      visibleSources.length = 0;
      const transformedSources = getTransformedSources(renderLayer);
      const numSources = transformedSources.length;
      const {mipLevelConstraints} = renderLayer;
      const { minScaleIndex, maxScaleIndex } = (mipLevelConstraints.numberLevels === undefined) ?
        { minScaleIndex: 0, maxScaleIndex: numSources - 1 } : {
          minScaleIndex: mipLevelConstraints.getDeFactoMinMIPLevel(),
          maxScaleIndex: mipLevelConstraints.getDeFactoMaxMIPLevel()
        };
      let scaleIndex: number;

      // At the smallest scale, all alternative sources must have the same voxel size, which is
      // considered to be the base voxel size.
      const smallestVoxelSize = transformedSources[0][0].voxelSize;

      /**
       * Determines whether we should continue to look for a finer-resolution source *after* one
       * with the specified voxelSize.
       */
      const canImproveOnVoxelSize = (voxelSize: vec3) => {
        for (let i = 0; i < 3; ++i) {
          let size = voxelSize[i];
          // If size <= pixelSize, no need for improvement.
          // If size === smallestVoxelSize, also no need for improvement.
          if (size > pixelSize && size > smallestVoxelSize[i]) {
            return true;
          }
        }
        return false;
      };

      let highestResolutionIndex;

      /**
       * Registers a source as being visible.  This should be called with consecutively decreasing
       * values of scaleIndex.
       */
      const addVisibleSource =
          (transformedSource: TransformedSource<Source>, sourceScaleIndex: number) => {
            // Add to end of visibleSources list.  We will reverse the list after all sources are
            // added.
            const {source, chunkLayout} = transformedSource;
            visibleSources[visibleSources.length++] = transformedSource;
            let existingSources = visibleChunkLayouts.get(chunkLayout);
            if (existingSources === undefined) {
              existingSources = new Map<Source, number>();
              visibleChunkLayouts.set(chunkLayout, existingSources);
            }
            existingSources.set(source, sourceScaleIndex);
            highestResolutionIndex = scaleIndex;
          };

      // Here we start iterating from numSources - 1, instead of from the user
      // specified maxMIPRendered, just in case the maxMIPRendered resolution
      // is wasteful. In this case we only retrieve the min MIP level that is not
      // wasteful. Otherwise we retrieve all the useful/not wasteful levels between
      // minMIPLevelRendered and maxMIPLevelRendered.
      for (scaleIndex = numSources - 1; scaleIndex >= minScaleIndex; --scaleIndex) {
        const transformedSource = pickBestAlternativeSource(zAxis, transformedSources[scaleIndex]);
        if (scaleIndex <= maxScaleIndex) {
          addVisibleSource(transformedSource, (scaleIndex + 1) / numSources);
        }
        if (!canImproveOnVoxelSize(transformedSource.voxelSize)) {
          if (scaleIndex > maxScaleIndex) {
            addVisibleSource(transformedSource, (scaleIndex + 1) / numSources);
          }
          break;
        }
      }

      if (renderLayer.activeMinMIPLevel) {
        renderLayer.activeMinMIPLevel.value = highestResolutionIndex;
      }

      // Reverse visibleSources list since we added sources from coarsest to finest resolution, but
      // we want them ordered from finest to coarsest.
      visibleSources.reverse();
    }
  }

  protected computeVisibleChunks<T>(
      getLayoutObject: (chunkLayout: ChunkLayout) => T,
      addChunk:
          (chunkLayout: ChunkLayout, layoutObject: T, lowerBound: vec3,
           fullyVisibleSources: SliceViewChunkSource[]) => void,
      rectangleOut?: GlobalCoordinateRectangle) {
    this.updateVisibleSources();
    const visibleRectangle = (rectangleOut) ? rectangleOut: tempGlobalRectangle;
    this.computeGlobalRectangle(visibleRectangle);
    return this.computeChunksWithinRectangle(
        getLayoutObject, addChunk, visibleRectangle);
  }

  // Used to get global coordinates of viewport corners. These corners
  // are used to find chunks within these corners in computeChunksFromGlobalCorners. The order of
  // these corners are relevant in the backend in computePrefetchChunksWithinPlane to construct the corners of
  // prefetch rectangles.
  protected computeGlobalRectangle(rectangleOut: GlobalCoordinateRectangle, widthMultiplier = 1, heightMultiplier = 1) {
    const {viewportToData, width, height} = this;
    const modifiedWidth = widthMultiplier * width;
    const modifiedHeight = heightMultiplier * height;
    for (let i = 0; i < 3; ++i) {
      rectangleOut[0][i] = -kAxes[0][i] * modifiedWidth / 2 - kAxes[1][i] * modifiedHeight / 2;
      rectangleOut[1][i] = -kAxes[0][i] * modifiedWidth / 2 + kAxes[1][i] * modifiedHeight / 2;
      rectangleOut[2][i] = kAxes[0][i] * modifiedWidth / 2 - kAxes[1][i] * modifiedHeight / 2;
      rectangleOut[3][i] = kAxes[0][i] * modifiedWidth / 2 + kAxes[1][i] * modifiedHeight / 2;
    }
    for (let i = 0; i < 4; ++i) {
      vec3.transformMat4(rectangleOut[i], rectangleOut[i], viewportToData);
    }
  }

  protected static getChunkBoundsForRectangle(
      chunkLayout: ChunkLayout, rectangle: GlobalCoordinateRectangle, lowerBoundOut: vec3,
      upperBoundOut: vec3) {
    vec3.set(
        lowerBoundOut, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY);
    vec3.set(
        upperBoundOut, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY,
        Number.NEGATIVE_INFINITY);
    for (let i = 0; i < 4; ++i) {
      const localCorner = chunkLayout.globalToLocalGrid(tempVec3, rectangle[i]);
      for (let j = 0; j < 3; ++j) {
        lowerBoundOut[j] = Math.min(lowerBoundOut[j], Math.floor(localCorner[j]));
        upperBoundOut[j] = Math.max(upperBoundOut[j], Math.floor(localCorner[j]) + 1);
      }
    }
  }

  protected computeChunksWithinRectangle<T>(
      getLayoutObject: (chunkLayout: ChunkLayout) => T,
      addChunk:
          (chunkLayout: ChunkLayout, layoutObject: T, lowerBound: vec3,
           fullyVisibleSources: SliceViewChunkSource[]) => void,
      rectangle: GlobalCoordinateRectangle,
      makeBoundsForRectangle?:
          (chunkLayout: ChunkLayout, rectangle: GlobalCoordinateRectangle, lowerBoundOut: vec3,
           upperBoundOut: vec3, voxelSize: vec3) => void) {
    // These variables hold the lower and upper bounds on chunk grid positions that intersect the
    // viewing plane.
    var lowerChunkBound = vec3.create();
    var upperChunkBound = vec3.create();

    let sourcesLowerChunkBound = vec3.create();
    let sourcesUpperChunkBound = vec3.create();

    // Vertex with maximal dot product with the positive viewport plane normal.
    // Implicitly, negativeVertex = 1 - positiveVertex.
    var positiveVertex = vec3.create();

    var planeNormal = vec3.create();

    const centerDataPosition = vec3.create();

    // Sources whose bounds partially contain the current bounding box.
    let partiallyVisibleSources = new Array<SliceViewChunkSource>();

    // Sources whose bounds fully contain the current bounding box.
    let fullyVisibleSources = new Array<SliceViewChunkSource>();

    const setCenterDataPosition = () => {
      vec3.copy(centerDataPosition, rectangle[0]);
      for (let i = 1; i < 4; ++i) {
        vec3.add(centerDataPosition, centerDataPosition, rectangle[i]);
      }
      vec3.scale(centerDataPosition, centerDataPosition, 0.25);
    };

    setCenterDataPosition();

    const computeChunksForLayout =
        (chunkLayout: ChunkLayout,
         visibleSources: Map<SliceViewChunkSource, number>): void => {
          let layoutObject = getLayoutObject(chunkLayout);

          const setupLocalChunkBounds = () => {
            computeSourcesChunkBounds(
                sourcesLowerChunkBound, sourcesUpperChunkBound, visibleSources.keys());
            if (DEBUG_CHUNK_INTERSECTIONS) {
              console.log(
                `Initial sources chunk bounds: ` +
                `${vec3.str(sourcesLowerChunkBound)}, ${vec3.str(sourcesUpperChunkBound)}`);
            }

            chunkLayout.globalToLocalSpatialVector(planeNormal, this.viewportAxes[2]);
            for (let i = 0; i < 3; ++i) {
              positiveVertex[i] = planeNormal[i] > 0 ? 1 : 0;
            }

            if (makeBoundsForRectangle) {
              makeBoundsForRectangle(chunkLayout, rectangle, lowerChunkBound, upperChunkBound, visibleSources.keys().next().value.spec.voxelSize);
              // rectangle modified in order to prefetch, reset center
              setCenterDataPosition();
            }
            else {
              SliceViewBase.getChunkBoundsForRectangle(chunkLayout, rectangle, lowerChunkBound, upperChunkBound);
            }
            vec3.max(lowerChunkBound, lowerChunkBound, sourcesLowerChunkBound);
            vec3.min(upperChunkBound, upperChunkBound, sourcesUpperChunkBound);
          };
          setupLocalChunkBounds();

          // Center position in chunk grid coordinates.
          const planeDistanceToOrigin =
              vec3.dot(chunkLayout.globalToLocalGrid(tempVec3, centerDataPosition), planeNormal);
          // Make sure bounds are not invalid. This can only happen when the backend is prefetching
          // along the normal to the plane, and tries to prefetch outside the bounds of the dataset
          if (areBoundsInvalid(lowerChunkBound, upperChunkBound)) {
            return;
          }

          // Checks whether [lowerBound, upperBound) intersects the viewport plane.
          //
          // positiveVertexDistanceToOrigin = dot(planeNormal, lowerBound +
          // positiveVertex * (upperBound - lowerBound)) - planeDistanceToOrigin;
          // negativeVertexDistanceToOrigin = dot(planeNormal, lowerBound +
          // negativeVertex * (upperBound - lowerBound)) - planeDistanceToOrigin;
          //
          // positive vertex must have positive distance, and negative vertex must
          // have negative distance.
          function intersectsPlane() {
            var positiveVertexDistanceToOrigin = 0;
            var negativeVertexDistanceToOrigin = 0;
            // Check positive vertex.
            for (let i = 0; i < 3; ++i) {
              let normalValue = planeNormal[i];
              let lowerValue = lowerChunkBound[i];
              let upperValue = upperChunkBound[i];
              let diff = upperValue - lowerValue;
              let positiveOffset = positiveVertex[i] * diff;
              // console.log(
              //     normalValue, lowerValue, upperValue, diff, positiveOffset,
              //     positiveVertexDistanceToOrigin, negativeVertexDistanceToOrigin);
              positiveVertexDistanceToOrigin += normalValue * (lowerValue + positiveOffset);
              negativeVertexDistanceToOrigin += normalValue * (lowerValue + diff - positiveOffset);
            }
            if (DEBUG_CHUNK_INTERSECTIONS) {
              console.log(`    planeNormal = ${planeNormal}`);
              console.log(
                  '    {positive,negative}VertexDistanceToOrigin: ', positiveVertexDistanceToOrigin,
                  negativeVertexDistanceToOrigin, planeDistanceToOrigin);
              console.log(
                  '    intersectsPlane:', negativeVertexDistanceToOrigin, planeDistanceToOrigin,
                  positiveVertexDistanceToOrigin);
            }
            if (positiveVertexDistanceToOrigin < planeDistanceToOrigin) {
              return false;
            }

            return negativeVertexDistanceToOrigin <= planeDistanceToOrigin;
          }

          function populateVisibleSources() {
            fullyVisibleSources.length = 0;
            partiallyVisibleSources.length = 0;
            for (let source of visibleSources.keys()) {
              let spec = source.spec;
              let result = compareBounds(
                  lowerChunkBound, upperChunkBound, spec.lowerChunkBound, spec.upperChunkBound);
              if (DEBUG_CHUNK_INTERSECTIONS) {
                console.log(
                    `Comparing source bounds lowerBound=${vec3.str(lowerChunkBound)}, ` +
                        `upperBound=${vec3.str(upperChunkBound)}, ` +
                        `lowerChunkBound=${vec3.str(spec.lowerChunkBound)}, ` +
                        `upperChunkBound=${vec3.str(spec.upperChunkBound)}, ` +
                        `got ${BoundsComparisonResult[result]}`,
                    spec, source);
              }
              switch (result) {
                case BoundsComparisonResult.FULLY_INSIDE:
                  fullyVisibleSources.push(source);
                  break;
                case BoundsComparisonResult.PARTIALLY_INSIDE:
                  partiallyVisibleSources.push(source);
                  break;
              }
            }
          }
          populateVisibleSources();
          let partiallyVisibleSourcesLength = partiallyVisibleSources.length;

          // Mutates lowerBound and upperBound while running, but leaves them the
          // same once finished.
          function checkBounds(nextSplitDim: number) {
            if (DEBUG_CHUNK_INTERSECTIONS) {
              console.log(
                  `chunk bounds: ${lowerChunkBound} ${upperChunkBound} ` +
                  `fullyVisible: ${fullyVisibleSources} partiallyVisible: ` +
                  `${partiallyVisibleSources.slice(0, partiallyVisibleSourcesLength)}`);
            }

            if (fullyVisibleSources.length === 0 && partiallyVisibleSourcesLength === 0) {
              if (DEBUG_CHUNK_INTERSECTIONS) {
                console.log('  no visible sources');
              }
              return;
            }

            if (DEBUG_CHUNK_INTERSECTIONS) {
              console.log(
                  `Check bounds: [ ${vec3.str(lowerChunkBound)}, ${vec3.str(upperChunkBound)} ]`);
            }
            var volume = 1;
            for (let i = 0; i < 3; ++i) {
              volume *= Math.max(0, upperChunkBound[i] - lowerChunkBound[i]);
            }

            if (volume === 0) {
              if (DEBUG_CHUNK_INTERSECTIONS) {
                console.log('  volume == 0');
              }
              return;
            }

            if (!intersectsPlane()) {
              if (DEBUG_CHUNK_INTERSECTIONS) {
                console.log('  doesn\'t intersect plane');
              }
              return;
            }

            if (DEBUG_CHUNK_INTERSECTIONS) {
              console.log(
                  'Within bounds: [' + vec3.str(lowerChunkBound) + ', ' +
                  vec3.str(upperChunkBound) + ']');
            }

            if (volume === 1) {
              addChunk(chunkLayout, layoutObject, lowerChunkBound, fullyVisibleSources);
              return;
            }

            var dimLower: number, dimUpper: number, diff: number;
            while (true) {
              dimLower = lowerChunkBound[nextSplitDim];
              dimUpper = upperChunkBound[nextSplitDim];
              diff = dimUpper - dimLower;
              if (diff === 1) {
                nextSplitDim = (nextSplitDim + 1) % 3;
              } else {
                break;
              }
            }

            let splitPoint = dimLower + Math.floor(0.5 * diff);
            let newNextSplitDim = (nextSplitDim + 1) % 3;
            let fullyVisibleSourcesLength = fullyVisibleSources.length;

            upperChunkBound[nextSplitDim] = splitPoint;

            let oldPartiallyVisibleSourcesLength = partiallyVisibleSourcesLength;
            function adjustSources() {
              partiallyVisibleSourcesLength = partitionArray(
                  partiallyVisibleSources, 0, oldPartiallyVisibleSourcesLength, source => {
                    let spec = source.spec;
                    let result = compareBounds(
                        lowerChunkBound, upperChunkBound, spec.lowerChunkBound,
                        spec.upperChunkBound);
                    switch (result) {
                      case BoundsComparisonResult.PARTIALLY_INSIDE:
                        return true;
                      case BoundsComparisonResult.FULLY_INSIDE:
                        fullyVisibleSources.push(source);
                      default:
                        return false;
                    }
                  });
            }

            adjustSources();
            checkBounds(newNextSplitDim);

            // Truncate list of fully visible sources.
            fullyVisibleSources.length = fullyVisibleSourcesLength;

            // Restore partiallyVisibleSources.
            partiallyVisibleSourcesLength = oldPartiallyVisibleSourcesLength;

            upperChunkBound[nextSplitDim] = dimUpper;
            lowerChunkBound[nextSplitDim] = splitPoint;

            adjustSources();
            checkBounds(newNextSplitDim);

            lowerChunkBound[nextSplitDim] = dimLower;

            // Truncate list of fully visible sources.
            fullyVisibleSources.length = fullyVisibleSourcesLength;

            // Restore partiallyVisibleSources.
            partiallyVisibleSourcesLength = oldPartiallyVisibleSourcesLength;
          }
          checkBounds(0);
        };

    for (const [curChunkLayout, curVisibleSources] of this.visibleChunkLayouts) {
      computeChunksForLayout(curChunkLayout, curVisibleSources);
    }
  }
}

/**
 * By default, choose a chunk size with at most 2^18 = 262144 voxels.
 */
export const DEFAULT_MAX_VOXELS_PER_CHUNK_LOG2 = 18;

/**
 * Specifies common options for getNearIsotropicBlockSize and getTwoDimensionalBlockSize.
 */
export interface BaseChunkLayoutOptions {
  /**
   * Voxel size in nanometers.
   */
  voxelSize: vec3;

  /**
   * This, together with upperVoxelBound, specifies the total volume dimensions, which serves as a
   * bound on the maximum chunk size.  If not specified, defaults to (0, 0, 0).
   */
  lowerVoxelBound?: vec3;

  /**
   * Upper voxel bound.  If not specified, the total volume dimensions are not used to bound the
   * chunk size.
   */
  upperVoxelBound?: vec3;

  /**
   * Base 2 logarithm of the maximum number of voxels per chunk.  Defaults to
   * DEFAULT_MAX_VOXELS_PER_CHUNK_LOG2.
   */
  maxVoxelsPerChunkLog2?: number;

  /**
   * Specifies an optional transform from local spatial coordinates to global coordinates.
   */
  transform?: mat4;
}

export interface GetNearIsotropicBlockSizeOptions extends BaseChunkLayoutOptions {
  maxBlockSize?: vec3;
}

/**
 * Determines a near-isotropic (in global spatial coordinates) block size.  All dimensions will be
 * powers of 2, and will not exceed upperVoxelBound - lowerVoxelBound.  The total number of voxels
 * will not exceed maxVoxelsPerChunkLog2.
 */
export function getNearIsotropicBlockSize(options: GetNearIsotropicBlockSizeOptions) {
  let {
    voxelSize,
    lowerVoxelBound = kZeroVec,
    upperVoxelBound,
    maxVoxelsPerChunkLog2 = DEFAULT_MAX_VOXELS_PER_CHUNK_LOG2,
    transform = identityMat4,
    maxBlockSize = kInfinityVec,
  } = options;

  // Adjust voxelSize by effective scaling factor.
  let temp = effectiveScalingFactorFromMat4(vec3.create(), transform);
  voxelSize = vec3.multiply(temp, temp, voxelSize);

  let chunkDataSize = vec3.fromValues(1, 1, 1);
  let maxChunkDataSize: vec3;
  if (upperVoxelBound === undefined) {
    maxChunkDataSize = maxBlockSize;
  } else {
    maxChunkDataSize = vec3.create();
    for (let i = 0; i < 3; ++i) {
      maxChunkDataSize[i] =
          Math.pow(2, Math.floor(Math.log2(upperVoxelBound[i] - lowerVoxelBound[i])));
    }
    vec3.min(maxChunkDataSize, maxChunkDataSize, maxBlockSize);
  }

  // Determine the dimension in which chunkDataSize should be increased.  This is the smallest
  // dimension (in nanometers) that is < maxChunkDataSize (in voxels).
  //
  // Returns -1 if there is no such dimension.
  function findNextDimension() {
    let minSize = Infinity;
    let minDimension = -1;
    for (let i = 0; i < 3; ++i) {
      if (chunkDataSize[i] >= maxChunkDataSize[i]) {
        continue;
      }
      let size = chunkDataSize[i] * voxelSize[i];
      if (size < minSize) {
        minSize = size;
        minDimension = i;
      }
    }
    return minDimension;
  }

  for (let i = 0; i < maxVoxelsPerChunkLog2; ++i) {
    let nextDim = findNextDimension();
    if (nextDim === -1) {
      break;
    }
    chunkDataSize[nextDim] *= 2;
  }
  return chunkDataSize;
}

/**
 * Computes a 3-d block size that has depth 1 in flatDimension and is near-isotropic (in nanometers)
 * in the other two dimensions.  The remaining options are the same as for
 * getNearIsotropicBlockSize.
 */
export function getTwoDimensionalBlockSize(options: {flatDimension: number}&
                                           BaseChunkLayoutOptions) {
  let {
    lowerVoxelBound = kZeroVec,
    upperVoxelBound = kInfinityVec,
    flatDimension,
    voxelSize,
    maxVoxelsPerChunkLog2,
    transform
  } = options;
  vec3.subtract(tempVec3, upperVoxelBound, lowerVoxelBound);
  tempVec3[flatDimension] = 1;
  return getNearIsotropicBlockSize(
      {voxelSize, upperVoxelBound: tempVec3, maxVoxelsPerChunkLog2, transform});
}

/**
 * Returns an array of [xy, xz, yz] 2-dimensional block sizes.
 */
export function getTwoDimensionalBlockSizes(options: BaseChunkLayoutOptions) {
  let chunkDataSizes = new Array<vec3>();
  for (let i = 0; i < 3; ++i) {
    chunkDataSizes[i] = getTwoDimensionalBlockSize({
      flatDimension: i,
      voxelSize: options.voxelSize,
      lowerVoxelBound: options.lowerVoxelBound,
      upperVoxelBound: options.upperVoxelBound,
      maxVoxelsPerChunkLog2: options.maxVoxelsPerChunkLog2,
      transform: options.transform,
    });
  }
  return chunkDataSizes;
}

export enum ChunkLayoutPreference {
  /**
   * Indicates that isotropic chunks are desired.
   */
  ISOTROPIC = 0,

  /**
   * Indicates that 2-D chunks are desired.
   */
  FLAT = 1,
}

export interface SliceViewSourceOptions {
  /**
   * Additional transform applied after the transform specified by the data source for transforming
   * from local to global coordinates.
   */
  transform?: mat4;
}

export function getCombinedTransform(transform: mat4|undefined, options: {transform?: mat4}) {
  let additionalTransform = options.transform;
  if (additionalTransform === undefined) {
    if (transform === undefined) {
      return identityMat4;
    }
    return transform;
  }
  if (transform === undefined) {
    return additionalTransform;
  }
  return mat4.multiply(mat4.create(), additionalTransform, transform);
}

/**
 * Specifies parameters for getChunkDataSizes.
 */
export interface ChunkLayoutOptions {
  /**
   * Chunk sizes in voxels.
   */
  chunkDataSizes?: vec3[];

  /**
   * Preferred chunk layout, which determines chunk sizes to use if chunkDataSizes is not
   * specified.
   */
  chunkLayoutPreference?: ChunkLayoutPreference;
}

export function getChunkDataSizes(options: ChunkLayoutOptions&BaseChunkLayoutOptions) {
  if (options.chunkDataSizes !== undefined) {
    return options.chunkDataSizes;
  }
  const {chunkLayoutPreference = ChunkLayoutPreference.ISOTROPIC} = options;
  switch (chunkLayoutPreference) {
    case ChunkLayoutPreference.ISOTROPIC:
      return [getNearIsotropicBlockSize(options)];
    case ChunkLayoutPreference.FLAT:
      let chunkDataSizes = getTwoDimensionalBlockSizes(options);
      chunkDataSizes.push(getNearIsotropicBlockSize(options));
      return chunkDataSizes;
  }
  throw new Error(`Invalid chunk layout preference: ${chunkLayoutPreference}.`);
}

/**
 * Generic specification for SliceView chunks specifying a layout and voxel size.
 */
export abstract class SliceViewChunkSpecification {
  chunkLayout: ChunkLayout;
  voxelSize: vec3;

  // All valid chunks are in the range [lowerChunkBound, upperChunkBound).
  lowerChunkBound: vec3;
  upperChunkBound: vec3;

  constructor(options: SliceViewChunkSpecificationOptions) {
    let {
      chunkSize,
      voxelSize,
      transform,
      lowerChunkBound = kZeroVec,
      upperChunkBound,
    } = options;
    this.voxelSize = voxelSize;
    this.chunkLayout = ChunkLayout.get(chunkSize, transform);

    this.lowerChunkBound = lowerChunkBound;
    this.upperChunkBound = upperChunkBound;
  }

  toObject(): SliceViewChunkSpecificationOptions {
    return {
      transform: this.chunkLayout.transform,
      chunkSize: this.chunkLayout.size,
      voxelSize: this.voxelSize,
      lowerChunkBound: this.lowerChunkBound,
      upperChunkBound: this.upperChunkBound,
    };
  }
}

/**
 * Common parameters for SliceView Chunks.
 */
export interface SliceViewChunkSpecificationBaseOptions {
  /**
   * Transform local spatial coordinates to global coordinates.
   */
  transform?: mat4;

  /**
   * Voxel size in local spatial coordinates.
   */
  voxelSize: vec3;
}


export interface SliceViewChunkSpecificationOptions extends SliceViewChunkSpecificationBaseOptions {
  lowerChunkBound?: vec3;
  upperChunkBound: vec3;

  chunkSize: vec3;
}


export interface SliceViewChunkSource {
  spec: SliceViewChunkSpecification;
}

export const SLICEVIEW_RPC_ID = 'SliceView';
export const SLICEVIEW_RENDERLAYER_RPC_ID = 'sliceview/RenderLayer';
export const SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID = 'SliceView.addVisibleLayer';
export const SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID = 'SliceView.removeVisibleLayer';
export const SLICEVIEW_UPDATE_PREFETCHING_RPC_ID = 'SliceView.updatePrefetching';
export const SLICEVIEW_UPDATE_VIEW_RPC_ID = 'SliceView.updateView';
export const SLICEVIEW_RENDERLAYER_UPDATE_TRANSFORM_RPC_ID = 'SliceView.updateTransform';
export const SLICEVIEW_RENDERLAYER_UPDATE_MIP_LEVEL_CONSTRAINTS_RPC_ID =
  'SliceView.updateMIPLevelConstraints';
