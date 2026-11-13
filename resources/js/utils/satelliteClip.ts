import type { CustomLayerInterface, Map as MapLibreMap } from 'maplibre-gl'
import type { Polygon } from 'geojson'

/** A display mask around the server polygon. No tiles or analytical geometry are changed.
 * Capture the layers below the raster, then restore them outside its screen contour.
 * Keeping both passes adjacent to the raster also preserves user-defined layer order.
 */
export function satelliteClipLayers(state: () => { enabled: boolean; area: Polygon | null }): CustomLayerInterface[] {
    let map: MapLibreMap
    let texture: WebGLTexture | null = null
    let buffer: WebGLBuffer | null = null
    let program: WebGLProgram | null = null
    let vao: WebGLVertexArrayObject | null = null
    let position = -1
    let sampler: WebGLUniformLocation | null = null
    let size: WebGLUniformLocation | null = null
    let captured = false
    let textureWidth = 0
    let textureHeight = 0
    const restoreContext = () => capture.onAdd?.(map, map.getCanvas().getContext('webgl2')!)

    function shader(gl: WebGL2RenderingContext, type: number, source: string) {
        const result = gl.createShader(type)!
        gl.shaderSource(result, source)
        gl.compileShader(result)
        if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
            const message = gl.getShaderInfoLog(result)
            gl.deleteShader(result)
            throw new Error(`Satellite display mask: ${message}`)
        }
        return result
    }

    const capture: CustomLayerInterface = {
        id: 'pa-satellite-clip-start', type: 'custom', renderingMode: '2d',
        onAdd(instance, context) {
            map = instance
            map.off('webglcontextrestored', restoreContext)
            map.on('webglcontextrestored', restoreContext)
            textureWidth = textureHeight = 0
            const gl = context as WebGL2RenderingContext
            texture = gl.createTexture()
            buffer = gl.createBuffer()
            vao = gl.createVertexArray()
            program = gl.createProgram()!
            const vertex = shader(gl, gl.VERTEX_SHADER, `#version 300 es
                in vec2 position;
                void main() { gl_Position = vec4(position, 0.0, 1.0); }`)
            const fragment = shader(gl, gl.FRAGMENT_SHADER, `#version 300 es
                precision highp float;
                uniform sampler2D backdrop;
                uniform vec2 size;
                out vec4 color;
                void main() { color = texture(backdrop, gl_FragCoord.xy / size); }`)
            gl.attachShader(program, vertex)
            gl.attachShader(program, fragment)
            gl.linkProgram(program)
            gl.deleteShader(vertex)
            gl.deleteShader(fragment)
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Satellite display mask could not be linked')
            position = gl.getAttribLocation(program, 'position')
            sampler = gl.getUniformLocation(program, 'backdrop')
            size = gl.getUniformLocation(program, 'size')
        },
        render(context) {
            captured = false
            if (!state().enabled || !texture) return
            const gl = context as WebGL2RenderingContext
            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, texture)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
            if (textureWidth !== gl.drawingBufferWidth || textureHeight !== gl.drawingBufferHeight) {
                textureWidth = gl.drawingBufferWidth
                textureHeight = gl.drawingBufferHeight
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, textureWidth, textureHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
            }
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, textureWidth, textureHeight)
            captured = true
        },
        onRemove(_map, context) {
            map.off('webglcontextrestored', restoreContext)
            const gl = context as WebGL2RenderingContext
            gl.deleteTexture(texture)
            gl.deleteBuffer(buffer)
            gl.deleteProgram(program)
            gl.deleteVertexArray(vao)
            texture = buffer = program = vao = null
        },
    }
    const restore: CustomLayerInterface = {
        id: 'pa-satellite-clip-end', type: 'custom', renderingMode: '2d',
        render(context) {
            if (!captured || !program || !buffer || !texture || !vao) return
            const gl = context as WebGL2RenderingContext
            const width = map.getCanvas().clientWidth
            const height = map.getCanvas().clientHeight
            if (!width || !height) return
            const vertices: number[] = []
            const point = (p: { x: number; y: number }) => vertices.push(p.x / width * 2 - 1, 1 - p.y / height * 2)
            const ring = state().area?.coordinates[0]
            if (ring && ring.length >= 4) {
                const inner = ring.slice(0, -1).map(p => map.project([p[0]!, p[1]!]))
                const center = inner.reduce((c, p) => ({ x: c.x + p.x / inner.length, y: c.y + p.y / inner.length }), { x: 0, y: 0 })
                // Expand each screen-space ray past all viewport corners. The
                // server's circle is convex; the resulting strip covers its exterior.
                const extent = (Math.hypot(center.x, center.y) + width + height + Math.max(...inner.map(p => Math.hypot(p.x - center.x, p.y - center.y)))) * 4
                const outer = inner.map(p => {
                    const distance = Math.max(Math.hypot(p.x - center.x, p.y - center.y), .000001)
                    return { x: center.x + (p.x - center.x) / distance * extent, y: center.y + (p.y - center.y) / distance * extent }
                })
                for (let i = 0; i < inner.length; i++) {
                    const j = (i + 1) % inner.length
                    point(inner[i]!); point(outer[i]!); point(inner[j]!)
                    point(inner[j]!); point(outer[i]!); point(outer[j]!)
                }
            } else {
                // Without confirmed geometry, never show the whole city as a circle.
                vertices.push(-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1)
            }
            gl.useProgram(program)
            gl.bindVertexArray(vao)
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW)
            gl.enableVertexAttribArray(position)
            gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, texture)
            gl.uniform1i(sampler, 0)
            gl.uniform2f(size, gl.drawingBufferWidth, gl.drawingBufferHeight)
            gl.disable(gl.DEPTH_TEST)
            gl.disable(gl.STENCIL_TEST)
            gl.disable(gl.CULL_FACE)
            gl.blendFunc(gl.ONE, gl.ZERO)
            gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 2)
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
            gl.bindVertexArray(null)
        },
    }
    return [capture, restore]
}
