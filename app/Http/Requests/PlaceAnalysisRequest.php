<?php

namespace App\Http\Requests;

use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Validation\Rule;

class PlaceAnalysisRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function validationData(): array
    {
        // Only the JSON body; preserve types and strings before global input transforms.
        return json_decode($this->getContent(), true, 32, JSON_THROW_ON_ERROR);
    }

    public function rules(): array
    {
        $integer = fn ($attribute, $value, $fail) => is_int($value) ?: $fail('Invalid integer.');
        $number = fn ($attribute, $value, $fail) => ((is_int($value) || is_float($value)) && is_finite((float) $value)) ?: $fail('Invalid number.');
        $body = json_decode($this->getContent(), false, 32, JSON_THROW_ON_ERROR);
        $list = fn ($attribute, $value, $fail) => is_array(data_get($body, $attribute)) ?: $fail('Invalid list.');
        $kind = $this->validationData()['place']['kind'] ?? null;

        $v2 = ($this->validationData()['analysis_version'] ?? null) === 2;
        if (array_diff(array_keys($this->validationData()), ['analysis_version', 'place', 'radius_m', 'date', 'stations', 'blocks']) !== []) {
            throw new HttpResponseException(response()->json(['code' => 'INVALID_REQUEST', 'message' => 'Некорректный запрос анализа места.'], 422));
        }

        return [
            'analysis_version' => ['sometimes', $integer, Rule::in([2])],
            'place' => ['required', $v2 ? 'array:kind,selection_token' : ($kind === 'address' ? 'array:kind,address_id' : 'array:kind,lon,lat')],
            'place.kind' => ['required', Rule::in($v2 ? ['address'] : ['address', 'point'])],
            'place.address_id' => [Rule::requiredIf($kind === 'address' && ! $v2), 'string'],
            'place.selection_token' => [Rule::requiredIf($v2), 'string', fn ($a, $v, $fail) => (is_string($v) && strlen($v) <= 6144) ?: $fail('Invalid token.')],
            'place.lon' => [Rule::requiredIf($kind === 'point'), $number, 'numeric', 'between:-180,180'],
            'place.lat' => [Rule::requiredIf($kind === 'point'), $number, 'numeric', 'between:-90,90'],
            'radius_m' => ['sometimes', $integer, 'integer', 'between:200,1000'],
            'date' => ['sometimes', 'string', 'date_format:Y-m-d'],
            'stations' => ['sometimes', 'array:selected_ids,radius_m'],
            'stations.selected_ids' => ['sometimes', $list, 'array', 'list', 'max:20'],
            'stations.selected_ids.*' => ['required', 'string', 'min:1', 'max:64', 'distinct:strict'],
            'stations.radius_m' => ['sometimes', $integer, 'integer', 'between:1000,20000'],
            'blocks' => ['sometimes', $list, 'array', 'list', 'min:1', 'max:3'],
            'blocks.*' => ['required', 'string', Rule::in(['poi', 'satellite', 'air']), 'distinct:strict'],
        ];
    }

    protected function failedValidation(Validator $validator): never
    {
        // Never echo user-controlled values or validation attribute paths.
        throw new HttpResponseException(response()->json([
            'code' => 'INVALID_REQUEST', 'message' => 'Некорректный запрос анализа места.',
        ], 422)->header('Cache-Control', 'no-store')->header('Referrer-Policy', 'no-referrer'));
    }
}
