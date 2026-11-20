<?php

namespace App\Http\Requests;

use App\Services\Geocoding\GeocodingFailure;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class GeocodingRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function validationData(): array
    {
        return json_decode($this->getContent(), true, 24, JSON_THROW_ON_ERROR);
    }

    public function rules(): array
    {
        $number = fn ($a, $v, $fail) => ((is_int($v) || is_float($v)) && is_finite((float) $v)) ?: $fail('Invalid number.');
        $token = fn ($a, $v, $fail) => (is_string($v) && strlen($v) <= 6144) ?: $fail('Invalid token.');
        $fields = match ($this->route('operation')) {
            'search' => ['q' => ['required', 'string', function ($a, $v, $fail) {
                if (! is_string($v)) {
                    $fail('Invalid query.');

                    return;
                }
                $len = mb_strlen(preg_replace('/^\s+|\s+$/u', '', $v));
                if ($len < 3 || $len > 160) {
                    $fail('Invalid query.');
                }
            }], 'mode' => ['required', Rule::in(['search', 'autocomplete'])]],
            'reverse' => ['lon' => ['required', $number, 'numeric', 'between:-180,180'], 'lat' => ['required', $number, 'numeric', 'between:-90,90']],
            'confirm' => ['candidate_token' => ['required', 'string', $token], 'position_confirmed' => ['required', fn ($a, $v, $fail) => $v === true ?: $fail('Confirmation required.')]],
            'reconfirm' => ['selection_token' => ['required', 'string', $token], 'position_confirmed' => ['required', fn ($a, $v, $fail) => $v === true ?: $fail('Confirmation required.')]],
        };
        $fields['request_id'] = ['required', 'string', 'uuid:4'];
        if (array_diff(array_keys($this->validationData()), array_keys($fields)) !== []) {
            throw new GeocodingFailure('INVALID_REQUEST', 422);
        }

        return $fields;
    }

    protected function failedValidation(Validator $validator): never
    {
        throw new GeocodingFailure('INVALID_REQUEST', 422);
    }
}
