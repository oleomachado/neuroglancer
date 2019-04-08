/**
 * @license
 * Copyright 2018 The Neuroglancer Authors
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

import {WithParameters} from 'neuroglancer/chunk_manager/backend';
import {MeshSourceParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/precomputed/base';
import {decodeJsonManifestChunk, decodeTriangleVertexPositionsAndIndices, decodeTriangleVertexPositionsAndIndicesDraco, FragmentChunk, ManifestChunk, MeshSource} from 'neuroglancer/mesh/backend';
import {decodeSkeletonVertexPositionsAndIndices, SkeletonChunk, SkeletonSource} from 'neuroglancer/skeleton/backend';
import {VertexAttributeInfo} from 'neuroglancer/skeleton/base';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeCompressedSegmentationChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/compressed_segmentation';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {DATA_TYPE_BYTES} from 'neuroglancer/util/data_type';
import {convertEndian16, convertEndian32, Endianness} from 'neuroglancer/util/endian';
import {openShardedHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {registerSharedObject} from 'neuroglancer/worker_rpc';
const DracoLoader = require('dracoloader');

const chunkDecoders = new Map<VolumeChunkEncoding, ChunkDecoder>();
chunkDecoders.set(VolumeChunkEncoding.RAW, decodeRawChunk);
chunkDecoders.set(VolumeChunkEncoding.JPEG, decodeJpegChunk);
chunkDecoders.set(VolumeChunkEncoding.COMPRESSED_SEGMENTATION, decodeCompressedSegmentationChunk);

@registerSharedObject() export class PrecomputedVolumeChunkSource extends
(WithParameters(VolumeChunkSource, VolumeChunkSourceParameters)) {
  chunkDecoder = chunkDecoders.get(this.parameters.encoding)!;

  download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;
    let path: string;
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      let chunkPosition = this.computeChunkBounds(chunk);
      let chunkDataSize = chunk.chunkDataSize!;
      path = `${parameters.path}/${chunkPosition[0]}-${chunkPosition[0] + chunkDataSize[0]}_` +
          `${chunkPosition[1]}-${chunkPosition[1] + chunkDataSize[1]}_` +
          `${chunkPosition[2]}-${chunkPosition[2] + chunkDataSize[2]}`;
    }
    return sendHttpRequest(
               openShardedHttpRequest(parameters.baseUrls, path), 'arraybuffer', cancellationToken)
        .then(response => this.chunkDecoder(chunk, response));
  }
}

export function decodeManifestChunk(chunk: ManifestChunk, response: any) {
  return decodeJsonManifestChunk(chunk, response, 'fragments');
}

export function decodeFragmentChunk(chunk: FragmentChunk, response: ArrayBuffer) {
  let dv = new DataView(response);
  let numVertices = dv.getUint32(0, true);
  decodeTriangleVertexPositionsAndIndices(
      chunk, response, Endianness.LITTLE, /*vertexByteOffset=*/4, numVertices);
}

export function decodeDracoFragmentChunk(chunk: FragmentChunk, response: ArrayBuffer, decoderModule: any) {
  decodeTriangleVertexPositionsAndIndicesDraco(chunk, response, decoderModule);
}

@registerSharedObject() export class PrecomputedMeshSource extends
(WithParameters(MeshSource, MeshSourceParameters)) {
  download(chunk: ManifestChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;
    let requestPath = `${parameters.path}/${chunk.objectId}:${parameters.lod}`;
    return sendHttpRequest(
               openShardedHttpRequest(parameters.baseUrls, requestPath), 'json', cancellationToken)
        .then(response => decodeManifestChunk(chunk, response));
  }

  downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;
    let requestPath = `${parameters.path}/${chunk.fragmentId}`;
    const fragmentDownloadPromise = sendHttpRequest(openShardedHttpRequest(parameters.baseUrls, requestPath), 'arraybuffer', cancellationToken);
    const dracoModulePromise = DracoLoader.default;
    const readyToDecode = Promise.all([fragmentDownloadPromise, dracoModulePromise]);
    return readyToDecode
      .then(response => {
        try {
          decodeDracoFragmentChunk(chunk, response[0], response[1].decoderModule);
        } catch (err) {
          if (err instanceof TypeError) {
            // not a draco mesh
            decodeFragmentChunk(chunk, response[0]);
          }
        }
      }, error => {
        Promise.reject(error);
      });
  }
}

function decodeSkeletonChunk(
    chunk: SkeletonChunk, response: ArrayBuffer,
    vertexAttributes: Map<string, VertexAttributeInfo>) {
  let dv = new DataView(response);
  let numVertices = dv.getUint32(0, true);
  let numEdges = dv.getUint32(4, true);
  const vertexPositionsStartOffset = 8;

  let curOffset = 8 + numVertices * 4 * 3;
  let attributes: Uint8Array[] = [];
  for (let info of vertexAttributes.values()) {
    const bytesPerVertex = DATA_TYPE_BYTES[info.dataType] * info.numComponents;
    const totalBytes = bytesPerVertex * numVertices;
    const attribute = new Uint8Array(response, curOffset, totalBytes);
    switch (bytesPerVertex) {
      case 2:
        convertEndian16(attribute, Endianness.LITTLE);
        break;
      case 4:
      case 8:
        convertEndian32(attribute, Endianness.LITTLE);
        break;
    }
    attributes.push(attribute);
    curOffset += totalBytes;
  }
  chunk.vertexAttributes = attributes;
  decodeSkeletonVertexPositionsAndIndices(
      chunk, response, Endianness.LITTLE, /*vertexByteOffset=*/vertexPositionsStartOffset,
      numVertices,
      /*indexByteOffset=*/curOffset, /*numEdges=*/numEdges);
}

@registerSharedObject() export class PrecomputedSkeletonSource extends
  (WithParameters(SkeletonSource, SkeletonSourceParameters)) {
  download(chunk: SkeletonChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    let requestPath = `${parameters.path}/${chunk.objectId}`;
    return sendHttpRequest(
               openShardedHttpRequest(parameters.baseUrls, requestPath), 'arraybuffer',
               cancellationToken)
        .then(response => decodeSkeletonChunk(chunk, response, parameters.vertexAttributes));
  }
}
