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

        return [
            'place' => ['required', $kind === 'address' ? 'array:kind,address_id' : 'array:kind,lon,lat'],
            'place.kind' => ['required', Rule::in(['address', 'point'])],
            'place.address_id' => [Rule::requiredIf($kind === 'address'), 'string'],
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
